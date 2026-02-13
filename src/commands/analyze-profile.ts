import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { spawnClaudeCLI } from '../lib/llm.js';
import { getLLMTaskConfig } from '../lib/config.js';
import { NetworkError } from '../lib/errors.js';
import { logWarn } from '../lib/fault-logger.js';

export interface ProjectProfile {
  languages: string[];
  sourceExtensions: string[];
  testPatterns: string[];
  ignoreDirectories: string[];
  projectFiles: string[];
  entryPoints: string[];
  keyFiles: string[];
  systems: Array<{ name: string; keyFile: string; description: string }>;
  features: Array<{ name: string; keyFile: string; description: string }>;
}

export interface ProfileItem {
  name: string;
  keyFile: string;
  description: string;
}

/**
 * Static project profiling using tree-sitter AST + file heuristics.
 * No LLM call needed — deterministic, instant, zero-cost.
 *
 * Extracts: languages, entry points, key files (by export count),
 * systems (by directory grouping), features (by exported symbols).
 */
export async function profileProjectWithAST(projectRoot: string): Promise<ProjectProfile> {
  const { getLanguageForExtension } = await import('../lib/tree-sitter/types.js');

  // 1. Scan file tree
  const allFiles = await glob('**/*', {
    cwd: projectRoot,
    ignore: [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/.succ/**',
      '**/vendor/**',
      '**/coverage/**',
      '**/__pycache__/**',
      '**/target/**',
      '**/.next/**',
      '**/.cache/**',
      '**/*.test.*',
      '**/*.spec.*',
      '**/test/**',
      '**/tests/**',
    ],
    nodir: true,
  });

  // 2. Detect languages from extensions
  const langCounts = new Map<string, number>();
  const extCounts = new Map<string, number>();
  const sourceFiles: string[] = [];

  for (const file of allFiles) {
    const ext = path.extname(file).toLowerCase();
    const lang = getLanguageForExtension(ext);
    if (lang) {
      langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
      extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
      sourceFiles.push(file);
    }
  }

  const languages = [...langCounts.entries()].sort((a, b) => b[1] - a[1]).map(([lang]) => lang);

  const sourceExtensions = [...extCounts.entries()].sort((a, b) => b[1] - a[1]).map(([ext]) => ext);

  // 3. Detect entry points (common patterns)
  const entryPointPatterns = [
    /^src\/(index|main|cli|app|server)\.[tj]sx?$/,
    /^(index|main|cli|app|server)\.[tj]sx?$/,
    /^src\/bin\/.*\.[tj]sx?$/,
    /^cmd\/.*\.(go)$/,
    /^main\.(py|go|rs)$/,
    /^src\/(main|lib)\.(rs|py)$/,
  ];
  const entryPoints = sourceFiles
    .filter((f) => entryPointPatterns.some((p) => p.test(f.replace(/\\/g, '/'))))
    .slice(0, 5);

  // 4. Detect project files
  const projectFileNames = [
    'package.json',
    'tsconfig.json',
    'go.mod',
    'Cargo.toml',
    'pyproject.toml',
    'pom.xml',
    'build.gradle',
    'README.md',
    '.env.example',
  ];
  const projectFiles = projectFileNames.filter(
    (pf) => allFiles.includes(pf) || fs.existsSync(path.join(projectRoot, pf))
  );

  // 5. Detect test patterns from existing files
  const testPatterns: string[] = [];
  if (allFiles.some((f) => f.includes('.test.'))) testPatterns.push('**/*.test.*');
  if (allFiles.some((f) => f.includes('.spec.'))) testPatterns.push('**/*.spec.*');
  if (
    allFiles.some((f) => {
      const n = f.replace(/\\/g, '/');
      return n.startsWith('test/') || n.startsWith('tests/');
    })
  )
    testPatterns.push('**/test/**', '**/tests/**');

  // 6. Extract symbols from key files using tree-sitter
  let parseCode: ((code: string, lang: string) => Promise<any>) | null = null;
  let extractSymbolsFn: ((tree: any, code: string, lang: string) => Promise<any[]>) | null = null;
  try {
    const parser = await import('../lib/tree-sitter/parser.js');
    const extractor = await import('../lib/tree-sitter/extractor.js');
    parseCode = parser.parseCode;
    extractSymbolsFn = extractor.extractSymbols;
  } catch {
    // tree-sitter not available
  }

  // Track exports per file for key file detection
  const fileExports: Array<{
    file: string;
    exports: number;
    symbols: Array<{ name: string; type: string }>;
  }> = [];

  if (parseCode && extractSymbolsFn) {
    // Parse up to 30 source files for symbol extraction
    const filesToParse = sourceFiles.filter((f) => !f.includes('.d.ts')).slice(0, 30);

    for (const file of filesToParse) {
      const ext = path.extname(file).toLowerCase();
      const lang = getLanguageForExtension(ext);
      if (!lang) continue;

      try {
        const content = fs.readFileSync(path.join(projectRoot, file), 'utf-8');
        if (content.length > 50000) continue; // skip very large files

        const tree = await parseCode(content, lang);
        if (!tree) continue;

        const symbols = await extractSymbolsFn(tree, content, lang);
        tree.delete();

        if (symbols.length > 0) {
          fileExports.push({
            file,
            exports: symbols.length,
            symbols: symbols.map((s) => ({ name: s.name, type: s.type })),
          });
        }
      } catch {
        // skip unparseable files
      }
    }
  }

  // 7. Determine key files (most exports)
  const keyFiles = fileExports
    .sort((a, b) => b.exports - a.exports)
    .slice(0, 10)
    .map((f) => f.file);

  // 8. Build systems from directory grouping
  const dirSymbols = new Map<string, { files: string[]; symbolCount: number; topFile: string }>();
  for (const fe of fileExports) {
    const dir = path.dirname(fe.file);
    const existing = dirSymbols.get(dir);
    if (existing) {
      existing.files.push(fe.file);
      existing.symbolCount += fe.exports;
      if (fe.exports > (fileExports.find((f) => f.file === existing.topFile)?.exports ?? 0)) {
        existing.topFile = fe.file;
      }
    } else {
      dirSymbols.set(dir, { files: [fe.file], symbolCount: fe.exports, topFile: fe.file });
    }
  }

  const systems = [...dirSymbols.entries()]
    .filter(([, v]) => v.symbolCount >= 3) // at least 3 symbols to be a "system"
    .sort((a, b) => b[1].symbolCount - a[1].symbolCount)
    .slice(0, 15)
    .map(([dir, v]) => {
      // Create human-readable name from directory path
      const parts = dir
        .replace(/\\/g, '/')
        .split('/')
        .filter((p) => p !== 'src' && p !== 'lib');
      const name =
        parts.length > 0
          ? parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
          : path.basename(v.topFile, path.extname(v.topFile));
      return {
        name,
        keyFile: v.topFile,
        description: `${v.symbolCount} symbols across ${v.files.length} file(s)`,
      };
    });

  // 9. Build features from exported functions (top-level only)
  const features = fileExports
    .flatMap((fe) =>
      fe.symbols
        .filter((s) => s.type === 'function' || s.type === 'class')
        .map((s) => ({ name: s.name, keyFile: fe.file, type: s.type }))
    )
    .slice(0, 15)
    .map((f) => ({
      name: f.name,
      keyFile: f.keyFile,
      description: `${f.type} in ${f.keyFile}`,
    }));

  return {
    languages,
    sourceExtensions,
    testPatterns,
    ignoreDirectories: ['node_modules', 'dist', '.git', '.succ', 'vendor', 'coverage'],
    projectFiles,
    entryPoints,
    keyFiles,
    systems,
    features,
  };
}

/**
 * LLM-based project profiling (Pass 0).
 * Sends the file tree to the LLM and gets back a structured profile:
 * languages, extensions, entry points, systems, features.
 */
export async function profileProjectWithLLM(
  projectRoot: string,
  mode: 'claude' | 'api',
  fast: boolean
): Promise<ProjectProfile> {
  // 1. Gather raw file tree (lightweight — only paths, no content)
  const allFiles = await glob('**/*', {
    cwd: projectRoot,
    ignore: [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/.succ/**',
      '**/vendor/**',
      '**/coverage/**',
      '**/__pycache__/**',
      '**/target/**',
      '**/.next/**',
      '**/.cache/**',
    ],
    nodir: true,
  });

  const treeLimit = fast ? 200 : 300;
  const fileTree = allFiles.slice(0, treeLimit).join('\n');
  const truncMsg =
    allFiles.length > treeLimit ? `\n... and ${allFiles.length - treeLimit} more files` : '';

  // 2. Build profiling prompt
  const prompt = `Analyze this project's file tree and respond with ONLY valid JSON (no markdown, no explanation).

## File Tree
\`\`\`
${fileTree}${truncMsg}
\`\`\`

Respond with this exact JSON structure:
{
  "languages": ["typescript", "javascript"],
  "sourceExtensions": [".ts", ".js"],
  "testPatterns": ["**/*.test.ts", "**/*.spec.ts", "**/*_test.go"],
  "ignoreDirectories": ["node_modules", "dist", ".succ", "coverage"],
  "projectFiles": ["package.json", "tsconfig.json", "README.md"],
  "entryPoints": ["src/cli.ts", "src/index.ts"],
  "keyFiles": ["src/lib/storage.ts", "src/mcp/server.ts"],
  "systems": [
    {"name": "Storage System", "keyFile": "src/lib/storage.ts", "description": "SQLite persistence layer"},
    {"name": "Embedding System", "keyFile": "src/lib/embeddings.ts", "description": "Vector embeddings"}
  ],
  "features": [
    {"name": "Memory System", "keyFile": "src/commands/memories.ts", "description": "Persistent semantic memory"},
    {"name": "Hybrid Search", "keyFile": "src/lib/search.ts", "description": "BM25 + vector search"}
  ]
}

Rules:
- Be EXHAUSTIVE — identify EVERY distinct system/module and EVERY user-facing feature
- Systems = internal modules/subsystems (storage, search, config, embedding, CLI, etc.)
- Features = user-facing capabilities (commands, API endpoints, integrations)
- keyFile = the most representative source file for that system/feature
- testPatterns should use glob patterns with ** prefix
- Do NOT include test files, build artifacts, or documentation in keyFiles
- Respond ONLY with valid JSON — no markdown fences, no explanation
- Use COMPACT JSON format (minimize whitespace) to save tokens`;

  // 3. Call LLM based on mode (with retry for flaky free models)
  let responseText = '';
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (mode === 'api') {
        responseText = await callApiRaw(prompt, 4096);
      } else {
        responseText = await spawnClaudeCLI(prompt, { tools: '', model: 'haiku', timeout: 60000 });
      }
    } catch (err) {
      logWarn('analyze', `LLM profiling call attempt ${attempt + 1} failed`, {
        error: String(err),
      });
      if (attempt === maxRetries) console.warn(`⚠ LLM profiling call failed: ${err}`);
    }
    if (responseText) break;
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 1000)); // brief pause before retry
    }
  }

  if (!responseText) {
    logWarn('analyze', 'LLM profiling returned empty response after retries');
    console.warn('⚠ LLM profiling returned empty response after retries');
    return getDefaultProfile();
  }

  // 4. Parse JSON (robust extraction)
  let jsonStr = '';

  // Strategy 1: Extract from markdown fenced code block
  const fenceMatch = responseText.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Strategy 2: Find first { to last } (raw JSON object)
  if (!jsonStr) {
    const firstBrace = responseText.indexOf('{');
    const lastBrace = responseText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = responseText.slice(firstBrace, lastBrace + 1);
    }
  }

  // Strategy 3: Use cleaned response as-is
  if (!jsonStr) {
    jsonStr = responseText
      .replace(/^```json?\s*\n?/i, '')
      .replace(/\n?```\s*$/, '')
      .trim();
  }

  // Try parse, then try repair if truncated
  let parsed: ProjectProfile | null = null;
  try {
    parsed = JSON.parse(jsonStr) as ProjectProfile;
  } catch {
    // Attempt to repair truncated JSON by closing open brackets
    const repaired = repairTruncatedJSON(jsonStr);
    if (repaired) {
      try {
        parsed = JSON.parse(repaired) as ProjectProfile;
        console.log('  (repaired truncated JSON)');
      } catch {
        /* still broken */
      }
    }
  }

  if (parsed) {
    // Validate required arrays exist
    if (!Array.isArray(parsed.languages)) parsed.languages = ['unknown'];
    if (!Array.isArray(parsed.sourceExtensions)) parsed.sourceExtensions = [];
    if (!Array.isArray(parsed.testPatterns)) parsed.testPatterns = [];
    if (!Array.isArray(parsed.ignoreDirectories)) parsed.ignoreDirectories = [];
    if (!Array.isArray(parsed.projectFiles)) parsed.projectFiles = [];
    if (!Array.isArray(parsed.entryPoints)) parsed.entryPoints = [];
    if (!Array.isArray(parsed.keyFiles)) parsed.keyFiles = [];
    if (!Array.isArray(parsed.systems)) parsed.systems = [];
    if (!Array.isArray(parsed.features)) parsed.features = [];
    return parsed;
  }

  logWarn('analyze', 'Could not parse LLM profile response, using fallback');
  console.warn('⚠ Could not parse LLM profile response, using fallback');
  return getDefaultProfile();
}

export function getDefaultProfile(): ProjectProfile {
  return {
    languages: ['unknown'],
    sourceExtensions: ['.ts', '.js', '.py', '.go', '.rs', '.java', '.rb', '.php'],
    testPatterns: ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**'],
    ignoreDirectories: ['node_modules', 'dist', '.git', '.succ', 'vendor', 'coverage'],
    projectFiles: ['package.json', 'README.md', 'go.mod', 'pyproject.toml', 'Cargo.toml'],
    entryPoints: [],
    keyFiles: [],
    systems: [],
    features: [],
  };
}

/**
 * Gather project context using LLM-generated profile.
 * Reads entry points, key files, and per-directory samples.
 */
export async function gatherProjectContext(
  projectRoot: string,
  profile: ProjectProfile,
  fast = false
): Promise<string> {
  const parts: string[] = [];

  // Header with detected info
  parts.push(`## Project: ${path.basename(projectRoot)}`);
  parts.push(`Languages: ${profile.languages.join(', ')}`);
  if (profile.systems.length > 0) {
    parts.push(`Identified systems: ${profile.systems.map((s) => s.name).join(', ')}`);
  }
  if (profile.features.length > 0) {
    parts.push(`Identified features: ${profile.features.map((f) => f.name).join(', ')}`);
  }
  parts.push('');

  // Build glob from detected extensions
  const sourceGlobs = profile.sourceExtensions.map((ext) => `**/*${ext}`);
  const allGlobs = [...sourceGlobs, '**/*.md', '**/*.json', '**/*.yaml', '**/*.yml', '**/*.toml'];

  const ignorePatterns = [
    ...profile.ignoreDirectories.map((d) => `**/${d}/**`),
    ...profile.testPatterns.map((p) => (p.startsWith('**/') ? p : `**/${p}`)),
    '**/*.d.ts',
  ];

  const files = await glob(allGlobs, {
    cwd: projectRoot,
    ignore: ignorePatterns,
    nodir: true,
  });

  // Full file tree
  const treeLimit = fast ? 100 : 500;
  parts.push('## File Structure\n```');
  parts.push(files.slice(0, treeLimit).join('\n'));
  if (files.length > treeLimit) parts.push(`... and ${files.length - treeLimit} more files`);
  parts.push('```\n');

  // Read project files (package.json, README.md, etc.)
  for (const keyFile of profile.projectFiles) {
    const filePath = path.join(projectRoot, keyFile);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8').slice(0, 3000);
      parts.push(`## ${keyFile}\n\`\`\`\n${content}\n\`\`\`\n`);
    }
  }

  // Read LLM-identified entry points and key files first
  const priorityFiles = [...new Set([...profile.entryPoints, ...profile.keyFiles])];
  const selectedFiles: string[] = [];

  for (const f of priorityFiles) {
    const filePath = path.join(projectRoot, f);
    if (fs.existsSync(filePath) && !selectedFiles.includes(f)) {
      selectedFiles.push(f);
    }
  }

  // Also read key files from identified systems/features
  for (const sys of profile.systems) {
    if (sys.keyFile && !selectedFiles.includes(sys.keyFile)) {
      const filePath = path.join(projectRoot, sys.keyFile);
      if (fs.existsSync(filePath)) selectedFiles.push(sys.keyFile);
    }
  }
  for (const feat of profile.features) {
    if (feat.keyFile && !selectedFiles.includes(feat.keyFile)) {
      const filePath = path.join(projectRoot, feat.keyFile);
      if (fs.existsSync(filePath)) selectedFiles.push(feat.keyFile);
    }
  }

  // Fill remaining slots with broad directory coverage
  const extSet = new Set(profile.sourceExtensions);
  const sourceFiles = files.filter((f) => extSet.has(path.extname(f)));
  const dirMap = new Map<string, string[]>();
  for (const f of sourceFiles) {
    const dir = path.dirname(f);
    if (!dirMap.has(dir)) dirMap.set(dir, []);
    dirMap.get(dir)!.push(f);
  }

  const maxPerDir = fast ? 1 : 2;
  const maxTotal = fast ? 15 : 40;
  for (const [, dirFiles] of dirMap) {
    for (const f of dirFiles.slice(0, maxPerDir)) {
      if (!selectedFiles.includes(f) && selectedFiles.length < maxTotal) {
        selectedFiles.push(f);
      }
    }
  }

  // Read selected source files
  const charLimit = fast ? 1500 : 3000;
  for (const sourceFile of selectedFiles) {
    const filePath = path.join(projectRoot, sourceFile);
    try {
      const content = fs.readFileSync(filePath, 'utf-8').slice(0, charLimit);
      parts.push(`## ${sourceFile}\n\`\`\`\n${content}\n\`\`\`\n`);
    } catch {
      /* skip unreadable */
    }
  }

  return parts.join('\n');
}

/**
 * Gather minimal project context for single file analysis
 */
export function gatherMinimalContext(projectRoot: string): string {
  const parts: string[] = [];

  // Read package.json for project info
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      parts.push(`Project: ${pkg.name || path.basename(projectRoot)}`);
      if (pkg.description) parts.push(`Description: ${pkg.description}`);
      if (pkg.dependencies) {
        const deps = Object.keys(pkg.dependencies).slice(0, 10).join(', ');
        parts.push(`Key dependencies: ${deps}`);
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Try other project files if no package.json
  if (parts.length === 0) {
    const projectFiles = ['go.mod', 'pyproject.toml', 'Cargo.toml'];
    for (const pf of projectFiles) {
      const pfPath = path.join(projectRoot, pf);
      if (fs.existsSync(pfPath)) {
        parts.push(`Project type: ${pf.replace(/\.[^.]+$/, '')}`);
        break;
      }
    }
  }

  // Get basic file structure (just top-level dirs)
  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    const dirs = entries
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith('.') &&
          !['node_modules', 'dist', 'build', 'vendor'].includes(e.name)
      )
      .map((e) => e.name)
      .slice(0, 8);
    if (dirs.length > 0) {
      parts.push(`Main directories: ${dirs.join(', ')}`);
    }
  } catch {
    // Ignore errors
  }

  return parts.join('\n');
}

/**
 * Get list of existing brain vault documents for wikilink suggestions
 */
export function getExistingBrainDocs(brainDir: string): string[] {
  const docs: string[] = [];

  if (!fs.existsSync(brainDir)) {
    return docs;
  }

  function walkDir(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.name.endsWith('.md')) {
          // Get document title (filename without .md)
          const docName = entry.name.replace(/\.md$/, '');
          docs.push(docName);
        }
      }
    } catch {
      // Ignore errors
    }
  }

  walkDir(brainDir);
  return [...new Set(docs)]; // Remove duplicates
}

/**
 * Attempt to repair truncated JSON by closing open strings, arrays, and objects.
 * Returns repaired string or null if beyond repair.
 */
function repairTruncatedJSON(json: string): string | null {
  if (!json || !json.startsWith('{')) return null;

  // Trim to last complete value boundary (after a comma, colon, or bracket)
  let trimmed = json.replace(/,\s*$/, ''); // trailing comma
  // Remove incomplete string value at the end (e.g., ..."descr)
  trimmed = trimmed.replace(/,\s*"[^"]*$/, ''); // trailing incomplete key
  trimmed = trimmed.replace(/:\s*"[^"]*$/, ': ""'); // truncated string value — close it
  trimmed = trimmed.replace(/:\s*$/, ': null'); // colon with no value

  // Count open brackets/braces and close them
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;
  for (const ch of trimmed) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') openBraces++;
    if (ch === '}') openBraces--;
    if (ch === '[') openBrackets++;
    if (ch === ']') openBrackets--;
  }

  // Close unclosed brackets/braces
  for (let i = 0; i < openBrackets; i++) trimmed += ']';
  for (let i = 0; i < openBraces; i++) trimmed += '}';

  return trimmed;
}

/**
 * Raw API call to any OpenAI-compatible endpoint (shared by profiling and agents)
 * Reads config from llm.analyze.*
 */
async function callApiRaw(prompt: string, maxTokens: number): Promise<string> {
  const cfg = getLLMTaskConfig('analyze');
  const apiUrl = cfg.api_url;

  const completionUrl = apiUrl.endsWith('/v1')
    ? `${apiUrl}/chat/completions`
    : apiUrl.endsWith('/v1/')
      ? `${apiUrl}chat/completions`
      : apiUrl.endsWith('/')
        ? `${apiUrl}v1/chat/completions`
        : `${apiUrl}/v1/chat/completions`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.api_key) {
    headers['Authorization'] = `Bearer ${cfg.api_key}`;
  }
  if (apiUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://succ.ai';
    headers['X-Title'] = 'succ';
  }

  const response = await fetch(completionUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
    }),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new NetworkError(`API error: ${response.status} - ${error}`, response.status);
  }
  const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices?.[0]?.message?.content || '';
}

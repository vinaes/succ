import fs from 'fs';
import path from 'path';
import { getLLMTaskConfig, getProjectRoot, getSuccDir } from '../lib/config.js';
import { NetworkError, ValidationError } from '../lib/errors.js';
import { spawnClaudeCLI } from '../lib/llm.js';
import { formatSymbolMap, batchChunks } from './analyze-helpers.js';
import { cleanMarkdownOutput, type MultiPassOptions } from './analyze-utils.js';
import { gatherMinimalContext, getExistingBrainDocs } from './analyze-profile.js';

/** Threshold for switching to recursive analysis (chars) */
export const RECURSIVE_ANALYSIS_THRESHOLD = 10_000;
/** Max chars per batch for chunk analysis */
export const CHUNK_BATCH_SIZE = 8_000;
/** Max concurrent chunk analysis calls */
export const CHUNK_ANALYSIS_CONCURRENCY = 3;

export interface AnalyzeFileOptions {
  mode?: 'claude' | 'api';
}

export interface AnalyzeFileResult {
  success: boolean;
  outputPath?: string;
  error?: string;
}

/**
 * Call the analyze LLM backend with a prompt (reuses analyzeFile's routing logic)
 */
async function callAnalyzeLLM(prompt: string, mode: 'claude' | 'api'): Promise<string | null> {
  if (mode === 'api') {
    const cfg = getLLMTaskConfig('analyze');
    const apiUrl = cfg.api_url;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (cfg.api_key) {
      headers['Authorization'] = `Bearer ${cfg.api_key}`;
    }
    if (apiUrl.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = 'https://succ.ai';
      headers['X-Title'] = 'succ';
    }

    const completionUrl = apiUrl.endsWith('/v1')
      ? `${apiUrl}/chat/completions`
      : apiUrl.endsWith('/v1/')
        ? `${apiUrl}chat/completions`
        : apiUrl.endsWith('/')
          ? `${apiUrl}v1/chat/completions`
          : `${apiUrl}/v1/chat/completions`;

    const response = await fetch(completionUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          {
            role: 'system',
            content: 'You are an expert software documentation writer. Generate clear, concise documentation.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: cfg.temperature ?? 0.3,
        max_tokens: cfg.max_tokens ?? 4096,
        stream: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new NetworkError(`API error: ${response.status} - ${error}`, response.status);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices?.[0]?.message?.content || null;
  } else {
    const { spawnClaudeCLI } = await import('../lib/llm.js');
    return await spawnClaudeCLI(prompt, { tools: '', model: 'haiku', timeout: 120000 }) || null;
  }
}

/**
 * Recursive analysis for large files: chunk → analyze → synthesize
 */
export async function analyzeFileRecursive(
  fileContent: string,
  absolutePath: string,
  relativePath: string,
  fileName: string,
  ext: string,
  projectName: string,
  projectContext: string,
  wikilinksSection: string,
  mode: 'claude' | 'api',
): Promise<string> {
  // Step 0: Extract symbol map via tree-sitter (fast, no LLM)
  let symbolMap = '(tree-sitter unavailable)';
  try {
    const { extractSymbolsFromFile } = await import('../lib/tree-sitter/public.js');
    const { symbols } = await extractSymbolsFromFile(absolutePath);
    symbolMap = formatSymbolMap(symbols);
  } catch {
    // tree-sitter unavailable — continue without symbol map
  }

  // Step 1: AST-aware chunking (tree-sitter with regex fallback)
  const { chunkCodeAsync } = await import('../lib/chunker.js');
  const chunks = await chunkCodeAsync(fileContent, absolutePath);

  if (chunks.length === 0) {
    throw new ValidationError('No chunks produced from file');
  }

  // Step 2: Batch chunks to fit LLM context
  const batches = batchChunks(chunks, CHUNK_BATCH_SIZE);
  const totalLines = fileContent.split('\n').length;

  // Step 3: Analyze each batch (sequential with concurrency limit)
  const chunkAnalyses: string[] = [];
  const pending: Promise<void>[] = [];
  let activeCount = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchContent = batch.map(c => c.content).join('\n\n');
    const startLine = batch[0].startLine;
    const endLine = batch[batch.length - 1].endLine;

    const chunkPrompt = `You are analyzing section ${i + 1}/${batches.length} of ${fileName} (${totalLines} lines total).

File symbol map (all definitions in this file):
${symbolMap}

Project context: ${projectContext}

Analyze this code section (lines ${startLine}-${endLine}) and extract:
1. What each function/class/interface does (purpose, key logic)
2. External dependencies imported
3. Internal dependencies (calls to other project modules)
4. Key patterns or algorithms
5. Notable complexity or edge cases

Code section:
\`\`\`${ext.slice(1) || 'text'}
${batchContent}
\`\`\`

Respond with a concise analysis. No frontmatter, no markdown headers, just facts.`;

    // Simple concurrency: wait if at limit
    while (activeCount >= CHUNK_ANALYSIS_CONCURRENCY) {
      await Promise.race(pending);
    }

    const idx = i;
    activeCount++;
    const p = callAnalyzeLLM(chunkPrompt, mode)
      .then(result => {
        chunkAnalyses[idx] = result || '(no analysis returned)';
      })
      .catch(err => {
        chunkAnalyses[idx] = `(analysis failed: ${err.message})`;
      })
      .finally(() => {
        activeCount--;
        pending.splice(pending.indexOf(p), 1);
      });
    pending.push(p);
  }

  // Wait for remaining
  await Promise.all(pending);

  // Step 4: Synthesize into unified document
  const analysisJoined = chunkAnalyses
    .map((a, i) => `### Section ${i + 1}/${batches.length}\n${a}`)
    .join('\n\n');

  const synthesisPrompt = `Create a unified documentation file for ${fileName} (${totalLines} lines).

## Project Context
${projectContext}
${wikilinksSection}

## File Symbol Map
${symbolMap}

## Section Analyses
${analysisJoined}

---

Synthesize these section analyses into a single documentation file:

1. YAML frontmatter (MUST be first):
---
description: "Brief description of this file's purpose"
project: ${projectName}
type: file-analysis
relevance: medium
file: ${relativePath}
---

2. Document structure:
# ${fileName}

**Parent:** [[Files]]
**Path:** \`${relativePath}\`

## Purpose
What this file does and why it exists.

## Key Components
Main functions, classes, exports with brief descriptions.

## Dependencies
What it imports/requires. Use [[wikilinks]] ONLY for documents in "Existing Documentation".

## Usage
How this file is used in the project.

CRITICAL FORMATTING RULES:
- Your response MUST start with exactly \`---\` on the first line
- NO text before the frontmatter
- **Parent:** must be [[Files]]
- ONLY use [[wikilinks]] for documents that exist in the "Existing Documentation" list
- If a related file doesn't have documentation yet, mention it as plain text`;

  const synthesized = await callAnalyzeLLM(synthesisPrompt, mode);
  if (!synthesized) {
    throw new NetworkError('Synthesis LLM call returned no content');
  }

  return synthesized;
}

export async function analyzeFile(
  filePath: string,
  options: AnalyzeFileOptions = {}
): Promise<AnalyzeFileResult> {
  const projectRoot = getProjectRoot();
  const succDir = getSuccDir();
  const brainDir = path.join(succDir, 'brain');

  // Determine mode
  const analyzeCfg = getLLMTaskConfig('analyze');
  let mode: 'claude' | 'api' = options.mode || (analyzeCfg.mode as 'claude' | 'api');

  // Check file exists
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(projectRoot, filePath);

  if (!fs.existsSync(absolutePath)) {
    return { success: false, error: `File not found: ${absolutePath}` };
  }

  // Read file content
  const fileContent = fs.readFileSync(absolutePath, 'utf-8');
  const fileName = path.basename(filePath);
  const relativePath = path.relative(projectRoot, absolutePath);
  const ext = path.extname(filePath).toLowerCase();

  // Determine output path in brain vault
  const projectName = path.basename(projectRoot);
  const outputDir = path.join(brainDir, '01_Projects', projectName, 'Files');
  const outputPath = path.join(outputDir, `${fileName}.md`);

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  // Ensure Files.md MOC exists
  const filesMocPath = path.join(brainDir, '01_Projects', projectName, 'Files.md');
  if (!fs.existsSync(filesMocPath)) {
    const filesMocContent = `---
description: "Source code file documentation"
project: ${projectName}
type: index
relevance: high
---

# Files

**Parent:** [[${projectName}]]

Map of documented source files. Each file analysis includes purpose, key components, dependencies, and usage.

## Documented Files

_Files are automatically added here when analyzed._
`;
    fs.writeFileSync(filesMocPath, filesMocContent);
  }

  // Gather minimal project context
  const projectContext = gatherMinimalContext(projectRoot);

  // Get existing brain docs for wikilink suggestions
  const existingDocs = getExistingBrainDocs(brainDir);
  const wikilinksSection = existingDocs.length > 0
    ? `\n## Existing Documentation (use these for [[wikilinks]]):\n${existingDocs.slice(0, 50).join(', ')}\n`
    : '';

  try {
    let content: string | null = null;

    if (fileContent.length > RECURSIVE_ANALYSIS_THRESHOLD) {
      // Large file: recursive chunk-analyze-synthesize
      content = await analyzeFileRecursive(
        fileContent, absolutePath, relativePath, fileName, ext,
        projectName, projectContext, wikilinksSection, mode,
      );
    } else {
      // Small file: single-pass analysis (original behavior)
      const prompt = `Analyze this source file and create documentation.

## Project Context
${projectContext}
${wikilinksSection}
## File to Analyze
File: ${relativePath}
Extension: ${ext}

Content:
\`\`\`${ext.slice(1) || 'text'}
${fileContent}
\`\`\`

---

Create a documentation file following these rules:

1. YAML frontmatter (MUST be first):
---
description: "Brief description of this file's purpose"
project: ${projectName}
type: file-analysis
relevance: medium
file: ${relativePath}
---

2. Document structure:
# ${fileName}

**Parent:** [[Files]]
**Path:** \`${relativePath}\`

## Purpose
What this file does and why it exists.

## Key Components
Main functions, classes, exports with brief descriptions.

## Dependencies
What it imports/requires. Use [[wikilinks]] ONLY for documents listed in "Existing Documentation" section above.

## Usage
How this file is used in the project. Reference related files with [[wikilinks]] ONLY if they exist in the documentation list.

CRITICAL FORMATTING RULES:
- Your response MUST start with exactly \`---\` on the first line
- NO text before the frontmatter (no "Let me...", "Here is...", "Based on...")
- The first 3 characters of your output must be the three dashes
- **Parent:** must be [[Files]] (not [[lib]] or folder names)
- ONLY use [[wikilinks]] for documents that exist in the "Existing Documentation" list
- If a related file doesn't have documentation yet, just mention it as plain text (no brackets)`;

      content = await callAnalyzeLLM(prompt, mode);
    }

    if (!content) {
      return { success: false, error: 'No content returned from LLM' };
    }

    // Clean output (remove preamble, code fences)
    const cleanedContent = cleanMarkdownOutput(content);

    // Write output
    fs.writeFileSync(outputPath, cleanedContent);

    return { success: true, outputPath };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

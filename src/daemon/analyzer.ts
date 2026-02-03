/**
 * Analyze Service for unified daemon
 *
 * Code analysis queue that runs discovery agents to find patterns,
 * learnings, and insights. Integrated into the main daemon process.
 */

import fs from 'fs';
import path from 'path';
import spawn from 'cross-spawn';
import { execFileSync } from 'child_process';
import { glob } from 'glob';
import { getProjectRoot, getSuccDir, getConfig } from '../lib/config.js';
import { withLock } from '../lib/lock.js';
import { getEmbedding, getEmbeddings } from '../lib/embeddings.js';
import { saveMemory, hybridSearchDocs } from '../lib/db.js';
import { scoreMemory, passesQualityThreshold } from '../lib/quality.js';

// ============================================================================
// Types
// ============================================================================

export interface AnalyzerState {
  active: boolean;
  lastRun: string | null;
  lastGitCommit: string | null;
  runsCompleted: number;
  memoriesCreated: number;
  queue: AnalyzeJob[];
  running: boolean;
  intervalId: NodeJS.Timeout | null;
}

export interface AnalyzeJob {
  file: string;
  mode: 'claude' | 'openrouter' | 'local';
  addedAt: number;
}

export interface AnalyzerConfig {
  intervalMinutes?: number;
  mode?: 'claude' | 'openrouter' | 'local';
  autoStart?: boolean;
}

interface Discovery {
  type: 'learning' | 'pattern' | 'decision' | 'observation';
  title: string;
  content: string;
  tags: string[];
}

// ============================================================================
// Analyzer State
// ============================================================================

let analyzerState: AnalyzerState | null = null;

// ============================================================================
// Helper Functions
// ============================================================================

function getCurrentCommit(projectRoot: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Gather minimal project context for analysis
 */
async function gatherProjectContext(projectRoot: string): Promise<string> {
  const lines: string[] = [];

  // Add package.json if exists
  const packagePath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
      lines.push(`Project: ${pkg.name || path.basename(projectRoot)}`);
      if (pkg.description) lines.push(`Description: ${pkg.description}`);
      if (pkg.dependencies) {
        lines.push(`Dependencies: ${Object.keys(pkg.dependencies).slice(0, 10).join(', ')}`);
      }
    } catch {}
  }

  // Add directory structure (top 2 levels)
  lines.push('\nDirectory structure:');
  const srcDir = path.join(projectRoot, 'src');
  if (fs.existsSync(srcDir)) {
    const files = await glob('**/*.{ts,js,py,go,rs}', {
      cwd: srcDir,
      ignore: ['**/node_modules/**', '**/dist/**'],
    });
    for (const file of files.slice(0, 20)) {
      lines.push(`  src/${file}`);
    }
  }

  return lines.join('\n');
}

/**
 * Run discovery agent to find patterns and learnings
 */
async function runDiscoveryAgent(
  context: string,
  mode: 'claude' | 'openrouter' | 'local',
  log: (msg: string) => void
): Promise<Discovery[]> {
  const prompt = `You are analyzing a software project to discover patterns, learnings, and insights worth remembering.

Project context:
${context}

Find 2-5 interesting discoveries. Each should be a concrete, reusable insight.

Output as JSON array:
[
  {
    "type": "learning" | "pattern" | "decision" | "observation",
    "title": "Short title",
    "content": "Detailed description (2-3 sentences)",
    "tags": ["tag1", "tag2"]
  }
]

If no interesting discoveries, output: []`;

  try {
    if (mode === 'openrouter') {
      const config = getConfig();
      if (!config.openrouter_api_key) {
        log('[analyze] OpenRouter API key not configured');
        return [];
      }

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openrouter_api_key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/cpz/succ',
          'X-Title': 'succ',
        },
        body: JSON.stringify({
          model: 'anthropic/claude-3.5-haiku',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2048,
        }),
      });

      if (!response.ok) {
        log(`[analyze] OpenRouter error: ${response.status}`);
        return [];
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const content = data.choices[0]?.message?.content || '';
      return parseDiscoveries(content);
    }

    if (mode === 'local') {
      const config = getConfig();
      if (!config.analyze_api_url || !config.analyze_model) {
        log('[analyze] Local LLM not configured');
        return [];
      }

      const response = await fetch(`${config.analyze_api_url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.analyze_model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2048,
          temperature: config.analyze_temperature ?? 0.3,
        }),
      });

      if (!response.ok) {
        log(`[analyze] Local LLM error: ${response.status}`);
        return [];
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const content = data.choices[0]?.message?.content || '';
      return parseDiscoveries(content);
    }

    // Default: Claude CLI
    return new Promise((resolve) => {
      const proc = spawn('claude', ['-p', '--tools', '', '--model', 'haiku'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, SUCC_SERVICE_SESSION: '1' },
        windowsHide: true, // Hide CMD window on Windows (works without detached)
      });

      proc.stdin?.write(prompt);
      proc.stdin?.end();

      let stdout = '';
      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.on('close', (code: number | null) => {
        if (code === 0 && stdout.trim()) {
          resolve(parseDiscoveries(stdout));
        } else {
          resolve([]);
        }
      });

      proc.on('error', () => resolve([]));

      // Timeout after 60 seconds
      setTimeout(() => {
        proc.kill();
        resolve([]);
      }, 60000);
    });
  } catch (err) {
    log(`[analyze] Error running discovery: ${err}`);
    return [];
  }
}

/**
 * Parse discoveries from LLM response
 */
function parseDiscoveries(content: string): Discovery[] {
  try {
    // Extract JSON array from response
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const discoveries = JSON.parse(jsonMatch[0]) as Discovery[];
    return discoveries.filter(
      (d) =>
        d.type &&
        d.title &&
        d.content &&
        Array.isArray(d.tags) &&
        ['learning', 'pattern', 'decision', 'observation'].includes(d.type)
    );
  } catch {
    return [];
  }
}

/**
 * Save discoveries in batch for better performance
 * - Batch embedding generation (1 call instead of N)
 * - Parallel quality scoring
 * - Single transaction for saves
 */
async function saveDiscoveriesBatch(
  discoveries: Discovery[],
  log: (msg: string) => void
): Promise<number> {
  if (discoveries.length === 0) return 0;

  // 1. Prepare contents
  const contents = discoveries.map(d => `${d.title}\n\n${d.content}`);

  // 2. Batch embedding generation (single call for all discoveries)
  const embeddings = await getEmbeddings(contents);

  // 3. Parallel quality scoring and dedup checking
  const validationResults = await Promise.all(
    discoveries.map(async (discovery, i) => {
      const content = contents[i];
      const embedding = embeddings[i];

      // Check for duplicates
      const similar = hybridSearchDocs(content, embedding, 3, 0.85);
      if (similar.length > 0) {
        return { valid: false, reason: 'duplicate' };
      }

      // Score quality
      const qualityResult = await scoreMemory(content);
      if (!passesQualityThreshold(qualityResult)) {
        return { valid: false, reason: 'low_quality' };
      }

      return { valid: true, qualityResult };
    })
  );

  // 4. Save valid discoveries
  let savedCount = 0;
  for (let i = 0; i < discoveries.length; i++) {
    const validation = validationResults[i];
    if (!validation.valid) {
      if (validation.reason === 'low_quality') {
        log(`[analyze] Discovery below quality threshold: ${discoveries[i].title}`);
      }
      continue;
    }

    const discovery = discoveries[i];
    const content = contents[i];
    const embedding = embeddings[i];
    const tags = [...discovery.tags, discovery.type, 'discovery'];

    const result = saveMemory(content, embedding, tags, discovery.type, {
      qualityScore: {
        score: validation.qualityResult!.score,
        factors: validation.qualityResult!.factors,
      },
    });

    if (!result.isDuplicate) {
      savedCount++;
      log(`[analyze] + ${discovery.title}`);
    }
  }

  return savedCount;
}

// ============================================================================
// Analyzer Service API
// ============================================================================

/**
 * Start the analyzer service
 */
export function startAnalyzer(
  config: AnalyzerConfig,
  log: (msg: string) => void
): AnalyzerState {
  if (analyzerState?.active) {
    log('[analyze] Already running');
    return analyzerState;
  }

  const projectRoot = getProjectRoot();
  const intervalMinutes = config.intervalMinutes ?? 30;
  const mode = config.mode ?? 'claude';

  analyzerState = {
    active: true,
    lastRun: null,
    lastGitCommit: null,
    runsCompleted: 0,
    memoriesCreated: 0,
    queue: [],
    running: false,
    intervalId: null,
  };

  // Run initial analysis
  runAnalysis(mode, log);

  // Schedule periodic runs
  analyzerState.intervalId = setInterval(
    () => runAnalysis(mode, log),
    intervalMinutes * 60 * 1000
  );

  log(`[analyze] Started (interval: ${intervalMinutes} min, mode: ${mode})`);

  return analyzerState;
}

/**
 * Stop the analyzer service
 */
export function stopAnalyzer(log: (msg: string) => void): void {
  if (!analyzerState?.active) {
    log('[analyze] Not running');
    return;
  }

  if (analyzerState.intervalId) {
    clearInterval(analyzerState.intervalId);
    analyzerState.intervalId = null;
  }

  analyzerState.active = false;
  analyzerState.queue = [];

  log('[analyze] Stopped');
}

/**
 * Run analysis now
 */
async function runAnalysis(
  mode: 'claude' | 'openrouter' | 'local',
  log: (msg: string) => void
): Promise<void> {
  if (!analyzerState || analyzerState.running) {
    return;
  }

  analyzerState.running = true;
  const projectRoot = getProjectRoot();

  try {
    log(`[analyze] Starting run #${analyzerState.runsCompleted + 1}`);

    // Check if code changed
    const currentCommit = getCurrentCommit(projectRoot);
    const codeChanged = currentCommit !== analyzerState.lastGitCommit;

    if (!codeChanged && analyzerState.lastRun) {
      log('[analyze] No code changes, skipping');
      analyzerState.running = false;
      return;
    }

    // Gather context
    const context = await gatherProjectContext(projectRoot);

    // Run discovery agent
    const discoveries = await runDiscoveryAgent(context, mode, log);

    if (discoveries.length > 0) {
      log(`[analyze] Found ${discoveries.length} discoveries`);

      // Batch process discoveries for better performance
      const savedCount = await saveDiscoveriesBatch(discoveries, log);
      analyzerState.memoriesCreated += savedCount;
    } else {
      log('[analyze] No new discoveries');
    }

    analyzerState.lastRun = new Date().toISOString();
    analyzerState.lastGitCommit = currentCommit;
    analyzerState.runsCompleted++;

    log(`[analyze] Run completed (total memories: ${analyzerState.memoriesCreated})`);
  } catch (err) {
    log(`[analyze] Error: ${err}`);
  } finally {
    analyzerState.running = false;
  }
}

/**
 * Queue a file for analysis
 */
export function queueFileForAnalysis(
  file: string,
  mode: 'claude' | 'openrouter' | 'local' = 'claude'
): void {
  if (!analyzerState) {
    analyzerState = {
      active: false,
      lastRun: null,
      lastGitCommit: null,
      runsCompleted: 0,
      memoriesCreated: 0,
      queue: [],
      running: false,
      intervalId: null,
    };
  }

  analyzerState.queue.push({
    file,
    mode,
    addedAt: Date.now(),
  });
}

/**
 * Get analyzer status
 */
export function getAnalyzerStatus(): {
  active: boolean;
  lastRun: string | null;
  runsCompleted: number;
  memoriesCreated: number;
  queueSize: number;
  running: boolean;
} {
  if (!analyzerState) {
    return {
      active: false,
      lastRun: null,
      runsCompleted: 0,
      memoriesCreated: 0,
      queueSize: 0,
      running: false,
    };
  }

  return {
    active: analyzerState.active,
    lastRun: analyzerState.lastRun,
    runsCompleted: analyzerState.runsCompleted,
    memoriesCreated: analyzerState.memoriesCreated,
    queueSize: analyzerState.queue.length,
    running: analyzerState.running,
  };
}

/**
 * Trigger analysis manually
 */
export async function triggerAnalysis(
  mode: 'claude' | 'openrouter' | 'local',
  log: (msg: string) => void
): Promise<void> {
  if (!analyzerState) {
    analyzerState = {
      active: false,
      lastRun: null,
      lastGitCommit: null,
      runsCompleted: 0,
      memoriesCreated: 0,
      queue: [],
      running: false,
      intervalId: null,
    };
  }

  await runAnalysis(mode, log);
}

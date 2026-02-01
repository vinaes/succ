/**
 * Quality Scoring Benchmark
 *
 * Compares different quality scoring modes:
 * - heuristic: Fast regex-based scoring (no model)
 * - local: ONNX zero-shot classification (Xenova/nli-deberta-v3-xsmall)
 * - openrouter: OpenRouter API with configurable model
 */

import {
  scoreWithHeuristics,
  scoreWithLocal,
  scoreWithCustom,
  scoreWithOpenRouter,
  formatQualityScore,
  cleanupQualityScoring,
  QualityScore,
} from '../lib/quality.js';
import { hasOpenRouterKey, getConfig } from '../lib/config.js';

// Default Ollama models to benchmark (small, fast models good for classification)
const OLLAMA_MODELS = [
  'qwen2.5:0.5b',    // Smallest, fastest
  'gemma2:2b',       // Good balance
  'phi3:mini',       // Microsoft's efficient model
];

interface BenchmarkResult {
  mode: string;
  model: string;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
}

interface AccuracyResult {
  mode: string;
  model: string;
  scores: {
    name: string;
    score: number;
    factors: QualityScore['factors'];
  }[];
  avgScore: number;
}

// Test cases with expected quality (high/medium/low)
const testCases = [
  // HIGH QUALITY - specific, technical, actionable
  {
    name: 'EN: Technical bug fix',
    content: 'Fixed bug in `handleAuth` function in src/auth.ts:42 where JWT tokens were not validated properly',
    expected: 'high',
  },
  {
    name: 'RU: Technical bug fix',
    content: 'Исправил баг в функции `handleAuth` в файле src/auth.ts:42, где JWT токены неправильно валидировались',
    expected: 'high',
  },
  {
    name: 'Code snippet',
    content: `Implemented retry logic with exponential backoff:
\`\`\`typescript
async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) { if (i === attempts - 1) throw e; await sleep(Math.pow(2, i) * 1000); }
  }
  throw new Error('Unreachable');
}
\`\`\``,
    expected: 'high',
  },
  {
    name: 'Architecture decision',
    content: 'Decision: Use PostgreSQL with pgvector extension for semantic search instead of dedicated vector database. Rationale: simpler infrastructure, good enough performance for our scale, single source of truth.',
    expected: 'high',
  },
  {
    name: 'RU: Architecture decision',
    content: 'Решение: Использовать PostgreSQL с pgvector вместо отдельной векторной БД. Причина: проще инфраструктура, достаточная производительность для нашего масштаба, единый источник данных.',
    expected: 'high',
  },

  // MEDIUM QUALITY - somewhat specific but less actionable
  {
    name: 'General observation',
    content: 'The authentication module uses JWT tokens for session management and refresh tokens for long-lived sessions.',
    expected: 'medium',
  },
  {
    name: 'RU: General observation',
    content: 'Модуль аутентификации использует JWT токены для управления сессиями и refresh токены для долгоживущих сессий.',
    expected: 'medium',
  },
  {
    name: 'Mixed language',
    content: 'Добавил feature для `UserService` класса - теперь поддерживает batch operations с retry logic',
    expected: 'medium',
  },

  // LOW QUALITY - vague, non-technical, or trivial
  {
    name: 'EN: Vague content',
    content: 'Something is wrong somehow with the thing',
    expected: 'low',
  },
  {
    name: 'RU: Vague content',
    content: 'Что-то не так где-то с чем-то',
    expected: 'low',
  },
  {
    name: 'Too short',
    content: 'fix bug',
    expected: 'low',
  },
  {
    name: 'Generic praise',
    content: 'The code is nice and works well',
    expected: 'low',
  },
  {
    name: 'RU: Generic praise',
    content: 'Код хороший и работает нормально',
    expected: 'low',
  },
];

// OpenRouter models to benchmark
const OPENROUTER_MODELS = [
  'openai/gpt-4o-mini',
  'anthropic/claude-3.5-haiku',
  'google/gemini-2.0-flash-001',
  'deepseek/deepseek-chat',
];

/**
 * Run benchmark for a single scoring mode
 */
async function benchmarkMode(
  modeName: string,
  modelName: string,
  scoreFn: (content: string) => Promise<QualityScore>
): Promise<{ timing: BenchmarkResult; accuracy: AccuracyResult }> {
  const times: number[] = [];
  const scores: AccuracyResult['scores'] = [];

  console.log(`\n  Running ${testCases.length} test cases...`);

  for (const testCase of testCases) {
    const start = Date.now();
    const result = await scoreFn(testCase.content);
    times.push(Date.now() - start);

    scores.push({
      name: testCase.name,
      score: result.score,
      factors: result.factors,
    });
  }

  const totalMs = times.reduce((a, b) => a + b, 0);
  const avgScore = scores.reduce((a, b) => a + b.score, 0) / scores.length;

  return {
    timing: {
      mode: modeName,
      model: modelName,
      totalMs,
      avgMs: totalMs / times.length,
      minMs: Math.min(...times),
      maxMs: Math.max(...times),
    },
    accuracy: {
      mode: modeName,
      model: modelName,
      scores,
      avgScore,
    },
  };
}

/**
 * Check if Ollama is running
 */
async function isOllamaRunning(url: string = 'http://localhost:11434'): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/tags`, { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get available Ollama models
 */
async function getOllamaModels(url: string = 'http://localhost:11434'): Promise<string[]> {
  try {
    const response = await fetch(`${url}/api/tags`);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.models || []).map((m: any) => m.name);
  } catch {
    return [];
  }
}

/**
 * Run quality scoring benchmark
 */
export async function benchmarkQuality(options: { openrouter?: boolean; ollama?: boolean; models?: string; ollamaUrl?: string } = {}): Promise<void> {
  const { openrouter = false, ollama = false, models, ollamaUrl = 'http://localhost:11434' } = options;

  console.log('═══════════════════════════════════════════════════════════');
  console.log('               QUALITY SCORING BENCHMARK                    ');
  console.log('═══════════════════════════════════════════════════════════');

  const allResults: { timing: BenchmarkResult; accuracy: AccuracyResult }[] = [];

  // ============ HEURISTIC BENCHMARK ============
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│ HEURISTIC (regex-based, no model)                           │');
  console.log('└─────────────────────────────────────────────────────────────┘');

  const heuristicResult = await benchmarkMode('heuristic', 'none', async (content) =>
    scoreWithHeuristics(content)
  );
  allResults.push(heuristicResult);

  // ============ LOCAL ONNX BENCHMARK ============
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│ LOCAL ONNX (Xenova/nli-deberta-v3-xsmall)                    │');
  console.log('└─────────────────────────────────────────────────────────────┘');

  console.log('\n  Loading model (first run may download ~50MB)...');
  const localResult = await benchmarkMode('local', 'Xenova/nli-deberta-v3-xsmall', async (content) =>
    scoreWithLocal(content)
  );
  allResults.push(localResult);

  // ============ OLLAMA BENCHMARK ============
  if (ollama) {
    const ollamaRunning = await isOllamaRunning(ollamaUrl);
    if (!ollamaRunning) {
      console.log('\n  ⓘ Ollama benchmark skipped (not running)');
      console.log(`    Start Ollama: ollama serve`);
      console.log(`    URL: ${ollamaUrl}`);
    } else {
      const availableModels = await getOllamaModels(ollamaUrl);

      // Parse models from CLI or use defaults
      const modelsToTest = models
        ? models.split(',').map((m) => m.trim())
        : OLLAMA_MODELS;

      for (const model of modelsToTest) {
        // Check if model is available
        const isAvailable = availableModels.some(m => m.startsWith(model.split(':')[0]));

        console.log('\n┌─────────────────────────────────────────────────────────────┐');
        console.log(`│ OLLAMA (${model.padEnd(49)}) │`);
        console.log('└─────────────────────────────────────────────────────────────┘');

        if (!isAvailable) {
          console.log(`  ⚠ Model not installed. Run: ollama pull ${model}`);
          continue;
        }

        try {
          const ollamaResult = await benchmarkMode('ollama', model, async (content) =>
            scoreWithCustom(content, ollamaUrl, model)
          );
          allResults.push(ollamaResult);
        } catch (error: any) {
          console.log(`  ⚠ Error: ${error.message}`);
        }
      }
    }
  }

  // ============ OPENROUTER BENCHMARK ============
  if (openrouter) {
    if (!hasOpenRouterKey()) {
      console.log('\n  ⓘ OpenRouter benchmark skipped (no API key)');
      console.log('    Set OPENROUTER_API_KEY or add to ~/.succ/config.json');
    } else {
      const config = getConfig();
      const apiKey = config.openrouter_api_key!;

      // Parse models from CLI or use defaults
      const modelsToTest = models
        ? models.split(',').map((m) => m.trim())
        : OPENROUTER_MODELS;

      for (const model of modelsToTest) {
        console.log('\n┌─────────────────────────────────────────────────────────────┐');
        console.log(`│ OPENROUTER (${model.padEnd(43)}) │`);
        console.log('└─────────────────────────────────────────────────────────────┘');

        try {
          const orResult = await benchmarkMode('openrouter', model, async (content) =>
            scoreWithOpenRouter(content, apiKey, model)
          );
          allResults.push(orResult);
        } catch (error: any) {
          console.log(`  ⚠ Error: ${error.message}`);
        }
      }
    }
  }

  // Cleanup
  cleanupQualityScoring();

  // ============ TIMING SUMMARY ============
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                    TIMING RESULTS                          ');
  console.log('═══════════════════════════════════════════════════════════');

  console.log('\n┌─────────────────────────────────────────────────────┬──────────┬──────────┬──────────┐');
  console.log('│ Mode / Model                                        │ Avg (ms) │ Min (ms) │ Max (ms) │');
  console.log('├─────────────────────────────────────────────────────┼──────────┼──────────┼──────────┤');

  for (const result of allResults) {
    const t = result.timing;
    const name = `${t.mode}: ${t.model}`.substring(0, 51).padEnd(51);
    const avg = t.avgMs.toFixed(0).padStart(8);
    const min = t.minMs.toFixed(0).padStart(8);
    const max = t.maxMs.toFixed(0).padStart(8);
    console.log(`│ ${name} │ ${avg} │ ${min} │ ${max} │`);
  }

  console.log('└─────────────────────────────────────────────────────┴──────────┴──────────┴──────────┘');

  // ============ ACCURACY SUMMARY ============
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                   ACCURACY RESULTS                         ');
  console.log('═══════════════════════════════════════════════════════════');

  // Print detailed scores for each mode
  for (const result of allResults) {
    const a = result.accuracy;
    console.log(`\n${a.mode.toUpperCase()}: ${a.model}`);
    console.log('─'.repeat(60));

    // Group by expected quality
    const highExpected = testCases.filter((t) => t.expected === 'high').map((t) => t.name);
    const medExpected = testCases.filter((t) => t.expected === 'medium').map((t) => t.name);
    const lowExpected = testCases.filter((t) => t.expected === 'low').map((t) => t.name);

    const avgHigh = a.scores
      .filter((s) => highExpected.includes(s.name))
      .reduce((sum, s) => sum + s.score, 0) / highExpected.length;

    const avgMed = a.scores
      .filter((s) => medExpected.includes(s.name))
      .reduce((sum, s) => sum + s.score, 0) / medExpected.length;

    const avgLow = a.scores
      .filter((s) => lowExpected.includes(s.name))
      .reduce((sum, s) => sum + s.score, 0) / lowExpected.length;

    console.log(`  HIGH quality (expected ≥0.65):   ${(avgHigh * 100).toFixed(0)}% avg`);
    console.log(`  MEDIUM quality (expected ~0.5):  ${(avgMed * 100).toFixed(0)}% avg`);
    console.log(`  LOW quality (expected ≤0.45):    ${(avgLow * 100).toFixed(0)}% avg`);
    console.log(`  Separation (HIGH - LOW):         ${((avgHigh - avgLow) * 100).toFixed(0)}pp`);

    // Quality discrimination score (higher is better)
    const discrimination = avgHigh - avgLow;
    const emoji = discrimination >= 0.3 ? '✓' : discrimination >= 0.15 ? '~' : '✗';
    console.log(`  Discrimination: ${emoji} ${discrimination >= 0.3 ? 'Good' : discrimination >= 0.15 ? 'Fair' : 'Poor'}`);
  }

  // ============ DETAILED SCORES ============
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                   DETAILED SCORES                          ');
  console.log('═══════════════════════════════════════════════════════════');

  // Print table header
  const modeHeaders = allResults.map((r) => r.timing.mode.substring(0, 10).padStart(10)).join(' │ ');
  console.log(`\n${'Test Case'.padEnd(25)} │ ${modeHeaders} │ Expected`);
  console.log('─'.repeat(25 + 3 + allResults.length * 13 + 10));

  for (const testCase of testCases) {
    const name = testCase.name.substring(0, 24).padEnd(25);
    const scores = allResults
      .map((r) => {
        const score = r.accuracy.scores.find((s) => s.name === testCase.name);
        return score ? `${(score.score * 100).toFixed(0)}%`.padStart(10) : '     N/A  ';
      })
      .join(' │ ');
    const expected = testCase.expected.padStart(8);
    console.log(`${name} │ ${scores} │ ${expected}`);
  }

  console.log('\n');
}

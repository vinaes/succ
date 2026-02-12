/**
 * Benchmark runner — orchestrates ingestion, retrieval, answering, evaluation
 */

import fs from 'fs';
import { readFile, writeFile, appendFile, access, mkdir, readdir } from 'fs/promises';
import { join } from 'path';
import { closeDb, resetStorageDispatcher } from '../../../src/lib/storage/index.js';
import { callLLMChat, type ChatMessage } from '../../../src/lib/llm.js';
import { setConfigOverride } from '../../../src/lib/config.js';
import { loadDataset } from './loader.js';
import { ingestQuestion } from './ingester.js';
import { retrieveMemories } from './retriever.js';
import { evaluate } from './evaluator.js';

// Bootstrap: read API key from project config (getConfig uses cwd which may not have .succ/)
if (!process.env.OPENROUTER_API_KEY) {
  try {
    const cfgPath = join(import.meta.dirname, '..', '..', '..', '.succ', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    if (cfg.openrouter_api_key) process.env.OPENROUTER_API_KEY = cfg.openrouter_api_key;
  } catch {}
}

// Force local embeddings (global config may default to ollama/nomic-embed-text)
setConfigOverride({
  embedding_mode: 'local',
  embedding_model: 'Xenova/all-MiniLM-L6-v2',
} as any);
import type {
  BenchmarkResult,
  BenchmarkMetrics,
  LongMemEvalQuestion,
  QuestionType,
  RunOptions,
} from './types.js';
import { MODEL_CONFIGS as MODELS } from './types.js';

const RESULTS_DIR = join(import.meta.dirname, '..', 'results');
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function isRetryableError(err: any): boolean {
  const msg = err?.message || '';
  const code = err?.cause?.code || '';

  // Non-retryable: auth, payment, config errors
  if (msg.includes('401') || msg.includes('402') || msg.includes('403') ||
      msg.includes('Payment Required') || msg.includes('Unauthorized') ||
      msg.includes('API_KEY not set')) {
    return false;
  }

  return (
    msg.includes('500') || msg.includes('502') || msg.includes('503') ||
    msg.includes('429') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') ||
    msg.includes('fetch failed') || msg.includes('Internal Server Error') ||
    msg.includes('ECONNREFUSED') || msg.includes('socket hang up') ||
    msg.includes('network') || msg.includes('timeout') ||
    code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' ||
    code === 'UND_ERR_SOCKET'
  );
}

/**
 * Retry with exponential backoff for transient API errors
 */
async function retryWithBackoff<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (!isRetryableError(err) || attempt === MAX_RETRIES) throw err;

      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
      console.log(`  [retry] ${label} attempt ${attempt + 1}/${MAX_RETRIES} — waiting ${Math.round(delay)}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}

/**
 * Generate an answer to a benchmark question using memories as context
 */
async function answerQuestion(
  question: string,
  questionDate: string | undefined,
  contextBlock: string,
  model: keyof typeof MODELS,
): Promise<string> {
  const modelConfig = MODELS[model];

  const systemPrompt = `You are a personal assistant that remembers past conversations with the user.
Below is relevant information retrieved from the user's conversation history. Use this information to answer the user's question.
Answer concisely and directly based on the retrieved context. If the context contains the answer, state it clearly.
If the context truly does not contain any relevant information, say so — but look carefully first, the answer is often present in the details.`;

  let userMessage = question;
  if (questionDate) {
    userMessage = `Current Date: ${questionDate}\nQuestion: ${question}`;
  }

  // Truncate context to ~6000 tokens (~24000 chars) to stay within API limits
  const maxContextChars = 24000;
  let truncatedContext = contextBlock;
  if (truncatedContext.length > maxContextChars) {
    truncatedContext = truncatedContext.slice(0, maxContextChars) + '\n\n[... additional context truncated]';
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: `${systemPrompt}\n\n${truncatedContext}` },
    { role: 'user', content: userMessage },
  ];

  return callLLMChat(messages, {
    temperature: 0,
    maxTokens: 500,
    useChatLLM: false,
  }, {
    backend: modelConfig.backend as any,
    openrouterModel: modelConfig.backend === 'openrouter' ? modelConfig.model : undefined,
    model: modelConfig.model,
  });
}

/**
 * Process a single benchmark question end-to-end
 */
async function processQuestion(
  question: LongMemEvalQuestion,
  options: RunOptions,
): Promise<BenchmarkResult> {
  const start = Date.now();

  // 1. Ingest conversations into isolated succ DB
  const { memoriesCount } = await ingestQuestion(question, options);

  // 2. Retrieve relevant memories
  // Multi-session and counting queries need more memories to cover all sessions
  const isCountingQuery = /how many|how much|total number|count of/i.test(question.question);
  const isMultiSession = question.question_type === 'multi-session';
  const effectiveTopK = (isCountingQuery || isMultiSession) ? Math.max(options.topK, 20) : options.topK;
  const { memories, contextBlock } = await retrieveMemories(question.question, effectiveTopK);

  // 3. Generate answer (with retry for transient API errors)
  const hypothesis = await retryWithBackoff(
    () => answerQuestion(question.question, question.question_date, contextBlock, options.model),
    `answer:${question.question_id}`,
  );

  // 4. Clean up DB before evaluation (frees memory)
  closeDb();
  resetStorageDispatcher();

  // 5. Evaluate answer (with retry for transient API errors)
  const isCorrect = await retryWithBackoff(
    () => evaluate(question.question_type, question.question_id, question.question, question.answer, hypothesis),
    `eval:${question.question_id}`,
  );

  const elapsed = Date.now() - start;

  return {
    question_id: question.question_id,
    question_type: question.question_type,
    question: question.question,
    expected_answer: question.answer,
    hypothesis,
    is_correct: isCorrect,
    memories_retrieved: memories.length,
    memories_total: memoriesCount,
    elapsed_ms: elapsed,
    model: options.model,
  };
}

/**
 * Calculate aggregate metrics from results
 */
function calculateMetrics(
  results: BenchmarkResult[],
  options: RunOptions,
): BenchmarkMetrics {
  const byType: Record<string, { correct: number; total: number }> = {};

  for (const r of results) {
    if (!byType[r.question_type]) {
      byType[r.question_type] = { correct: 0, total: 0 };
    }
    byType[r.question_type].total++;
    if (r.is_correct) byType[r.question_type].correct++;
  }

  const accuracyByType: Record<QuestionType, { correct: number; total: number; accuracy: number }> = {} as any;
  for (const [type, stats] of Object.entries(byType)) {
    accuracyByType[type as QuestionType] = {
      ...stats,
      accuracy: stats.total > 0 ? stats.correct / stats.total : 0,
    };
  }

  // Overall = average of per-type accuracies (official methodology)
  const typeAccuracies = Object.values(accuracyByType).map(t => t.accuracy);
  const overallAccuracy = typeAccuracies.length > 0
    ? typeAccuracies.reduce((a, b) => a + b, 0) / typeAccuracies.length
    : 0;

  return {
    total_questions: results.length,
    correct_answers: results.filter(r => r.is_correct).length,
    overall_accuracy: overallAccuracy,
    accuracy_by_type: accuracyByType,
    model: options.model,
    dataset: options.dataset,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Display metrics to console
 */
function displayMetrics(metrics: BenchmarkMetrics): void {
  console.log('\n=== LongMemEval Results ===\n');
  console.log(`Model: ${metrics.model}`);
  console.log(`Dataset: ${metrics.dataset}`);
  console.log(`Total: ${metrics.correct_answers}/${metrics.total_questions}`);
  console.log(`Overall Accuracy: ${(metrics.overall_accuracy * 100).toFixed(2)}%\n`);

  console.log('By Question Type:');
  const sorted = Object.entries(metrics.accuracy_by_type).sort(([a], [b]) => a.localeCompare(b));
  for (const [type, stats] of sorted) {
    const bar = '█'.repeat(Math.round(stats.accuracy * 20)) + '░'.repeat(20 - Math.round(stats.accuracy * 20));
    console.log(`  ${type.padEnd(28)} ${(stats.accuracy * 100).toFixed(1).padStart(5)}% [${bar}] (${stats.correct}/${stats.total})`);
  }

  console.log('\nComparison with Mastra OM (GPT-4o): 84.23%');
}

/**
 * Run the benchmark
 */
export async function run(options: RunOptions): Promise<BenchmarkMetrics> {
  // Load dataset
  const questions = await loadDataset(options.dataset);

  // Filter
  let toProcess = questions;
  if (options.questionId) {
    toProcess = questions.filter(q => q.question_id === options.questionId);
  } else if (options.questionType) {
    toProcess = questions.filter(q => q.question_type === options.questionType);
  }
  if (options.offset) {
    toProcess = toProcess.slice(options.offset);
  }
  if (options.subset) {
    toProcess = toProcess.slice(0, options.subset);
  }

  console.log(`\nProcessing ${toProcess.length} questions (model: ${options.model}, mode: ${options.mode})\n`);

  // Setup output — resume finds latest existing run, otherwise create new
  let runDir: string;
  if (options.resume) {
    const modelDir = join(RESULTS_DIR, options.model);
    try {
      const runs = (await readdir(modelDir)).filter(d => d.startsWith('run_')).sort();
      if (runs.length > 0) {
        runDir = join(modelDir, runs[runs.length - 1]);
      } else {
        runDir = join(modelDir, `run_${Date.now()}`);
      }
    } catch {
      runDir = join(modelDir, `run_${Date.now()}`);
    }
  } else {
    runDir = join(RESULTS_DIR, options.model, `run_${Date.now()}`);
  }
  await mkdir(runDir, { recursive: true });
  const resultsPath = join(runDir, 'results.jsonl');

  // Load existing results if resuming
  let existing: BenchmarkResult[] = [];
  if (options.resume && await fileExists(resultsPath)) {
    const raw = await readFile(resultsPath, 'utf-8');
    existing = raw.trim().split('\n').filter(l => l).map(l => JSON.parse(l));
    console.log(`Resuming: ${existing.length} existing results from ${runDir}`);
  }
  const completedIds = new Set(existing.map(r => r.question_id));
  const remaining = toProcess.filter(q => !completedIds.has(q.question_id));

  if (remaining.length === 0) {
    console.log('All questions already completed!');
    const allResults = [...existing];
    const metrics = calculateMetrics(allResults, options);
    displayMetrics(metrics);
    return metrics;
  }

  console.log(`Evaluating ${remaining.length} questions...\n`);

  // Process sequentially (concurrency adds complexity with DB singleton)
  const results: BenchmarkResult[] = [...existing];
  let completed = 0;

  for (const question of remaining) {
    const questionStart = Date.now();

    try {
      // Retry the entire question pipeline (ingestion + retrieval + answer + eval)
      const result = await retryWithBackoff(
        async () => {
          try { closeDb(); resetStorageDispatcher(); } catch {} // Clean slate for retries
          return processQuestion(question, options);
        },
        `question:${question.question_id}`,
      );
      results.push(result);

      // Incremental save
      await appendFile(resultsPath, JSON.stringify(result) + '\n');

      completed++;
      const icon = result.is_correct ? '✓' : '✗';
      const elapsed = ((Date.now() - questionStart) / 1000).toFixed(1);
      console.log(
        `[${completed}/${remaining.length}] ${icon} ${result.question_id} (${result.question_type}) — ${elapsed}s — ${result.memories_retrieved}/${result.memories_total} memories`
      );
      if (!result.is_correct) {
        console.log(`  Q: "${result.question}"`);
        console.log(`  A: "${result.hypothesis}"`);
        console.log(`  Expected: "${result.expected_answer}"`);
      }
    } catch (err: any) {
      console.error(`  SKIP ${question.question_id} after ${MAX_RETRIES} retries:`, err?.message || err);
      try { closeDb(); resetStorageDispatcher(); } catch {}
    }
  }

  // Save metrics
  const metrics = calculateMetrics(results, options);
  await writeFile(join(runDir, 'metrics.json'), JSON.stringify(metrics, null, 2));

  displayMetrics(metrics);
  console.log(`\nResults saved to: ${runDir}`);

  return metrics;
}

/**
 * Show latest results
 */
export async function showLatestResults(model?: string): Promise<void> {
  const models = model ? [model] : ['gpt-4o', 'sonnet'];

  for (const m of models) {
    const modelDir = join(RESULTS_DIR, m);
    if (!(await fileExists(modelDir))) continue;

    const { readdir } = await import('fs/promises');
    const runs = (await readdir(modelDir)).filter(d => d.startsWith('run_')).sort().reverse();
    if (runs.length === 0) continue;

    const metricsPath = join(modelDir, runs[0], 'metrics.json');
    if (!(await fileExists(metricsPath))) continue;

    const metrics = JSON.parse(await readFile(metricsPath, 'utf-8')) as BenchmarkMetrics;
    displayMetrics(metrics);
  }
}

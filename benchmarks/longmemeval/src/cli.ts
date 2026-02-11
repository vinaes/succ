#!/usr/bin/env tsx
/**
 * LongMemEval benchmark CLI for succ
 *
 * Usage:
 *   tsx src/cli.ts run --dataset s --model gpt-4o --subset 10
 *   tsx src/cli.ts run --dataset s --model sonnet
 *   tsx src/cli.ts download --dataset s
 *   tsx src/cli.ts results
 */

import { Command } from 'commander';
import { run, showLatestResults } from './runner.js';
import { downloadDataset } from './loader.js';
import type { DatasetVariant, AnswerModel, QuestionType, RunOptions } from './types.js';

const program = new Command();

program
  .name('longmemeval')
  .description('LongMemEval benchmark runner for succ memory system')
  .version('0.1.0');

program
  .command('run')
  .description('Run the benchmark')
  .option('-d, --dataset <variant>', 'Dataset variant: s, m, oracle', 's')
  .option('-m, --model <model>', 'Answer model: gpt-4o, sonnet', 'gpt-4o')
  .option('-n, --subset <count>', 'Only process first N questions', parseInt)
  .option('--offset <count>', 'Skip first N questions', parseInt)
  .option('-t, --question-type <type>', 'Filter by question type')
  .option('-q, --question-id <id>', 'Run single question by ID')
  .option('-c, --concurrency <n>', 'Concurrent workers', parseInt, 1)
  .option('--mode <mode>', 'Ingestion mode: direct, extract', 'direct')
  .option('--top-k <k>', 'Top-K memories to retrieve', parseInt, 10)
  .option('--resume', 'Resume from last run')
  .action(async (opts) => {
    const options: RunOptions = {
      dataset: opts.dataset as DatasetVariant,
      model: opts.model as AnswerModel,
      subset: opts.subset,
      offset: opts.offset,
      questionType: opts.questionType as QuestionType | undefined,
      questionId: opts.questionId,
      concurrency: opts.concurrency,
      mode: opts.mode as 'extract' | 'direct',
      topK: opts.topK,
      resume: opts.resume,
    };

    await run(options);
  });

program
  .command('download')
  .description('Download dataset from HuggingFace')
  .option('-d, --dataset <variant>', 'Dataset variant: s, m, oracle', 's')
  .action(async (opts) => {
    await downloadDataset(opts.dataset as DatasetVariant);
  });

program
  .command('results')
  .description('Show latest benchmark results')
  .option('-m, --model <model>', 'Filter by model')
  .action(async (opts) => {
    await showLatestResults(opts.model);
  });

program.parse();

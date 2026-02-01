#!/usr/bin/env node

import { Command } from 'commander';
import { init } from './commands/init.js';
import { index } from './commands/index.js';
import { search } from './commands/search.js';
import { status } from './commands/status.js';
import { analyze } from './commands/analyze.js';
import { chat } from './commands/chat.js';
import { watch } from './commands/watch.js';
import { config } from './commands/config.js';
import { memories, remember, forget } from './commands/memories.js';
import { indexCode } from './commands/index-code.js';
import { benchmark } from './commands/benchmark.js';
import { benchmarkQuality } from './commands/benchmark-quality.js';
import { clear } from './commands/clear.js';
import { soul } from './commands/soul.js';
import { graph } from './commands/graph.js';

const VERSION = '1.0.0';

const program = new Command();

program
  .name('succ')
  .description('Semantic Understanding for Claude Code - local memory system')
  .version(VERSION);

program
  .command('init')
  .description('Initialize succ in current project')
  .option('-f, --force', 'Overwrite existing configuration')
  .option('-y, --yes', 'Non-interactive mode (skip prompts)')
  .option('-v, --verbose', 'Show detailed output (created files, etc.)')
  .action(init);

program
  .command('index [path]')
  .description('Index files for semantic search (incremental by default)')
  .option('-r, --recursive', 'Index recursively', true)
  .option('--pattern <glob>', 'File pattern to match', '**/*.md')
  .option('-f, --force', 'Force reindex all files (ignore cache)')
  .action(index);

program
  .command('search <query>')
  .description('Semantic search across indexed content')
  .option('-n, --limit <number>', 'Number of results', '5')
  .option('-t, --threshold <number>', 'Similarity threshold (0-1)', '0.2')
  .action(search);

program
  .command('status')
  .description('Show index statistics')
  .action(status);

program
  .command('add <file>')
  .description('Add a single file to the index')
  .action(async (file: string) => {
    await index(file, { recursive: false, pattern: '*' });
  });

program
  .command('analyze')
  .description('Analyze project with Claude agents and generate brain vault')
  .option('--sequential', 'Run agents sequentially instead of parallel')
  .option('--openrouter', 'Use OpenRouter API instead of Claude CLI')
  .option('--local', 'Use local LLM API (Ollama, LM Studio, llama.cpp)')
  .option('--background', 'Run analysis in background (detached process)')
  .option('--daemon', 'Start daemon (continuous background analysis)')
  .option('--stop', 'Stop daemon')
  .option('--status', 'Show daemon status')
  .option('--daemon-worker', 'Internal: run daemon worker')
  .option('--interval <minutes>', 'Interval for daemon mode in minutes', '30')
  .action(async (options) => {
    // Import daemon control functions
    const { stopAnalyzeDaemon, analyzeDaemonStatus, runDaemonWorker } = await import('./commands/analyze.js');

    if (options.stop) {
      await stopAnalyzeDaemon();
      return;
    }

    if (options.status) {
      await analyzeDaemonStatus();
      return;
    }

    if (options.daemonWorker) {
      // Internal: called by daemon process
      await runDaemonWorker(parseInt(options.interval, 10), options.openrouter || options.local);
      return;
    }

    analyze({
      parallel: !options.sequential,
      openrouter: options.openrouter,
      local: options.local,
      background: options.background,
      daemon: options.daemon,
      interval: parseInt(options.interval, 10),
    });
  });

program
  .command('chat <query>')
  .description('RAG chat - search context and ask Claude')
  .option('-n, --limit <number>', 'Number of context chunks', '5')
  .option('-t, --threshold <number>', 'Similarity threshold (0-1)', '0.2')
  .option('-v, --verbose', 'Show search results before asking')
  .action((query, options) => {
    chat(query, {
      limit: parseInt(options.limit, 10),
      threshold: parseFloat(options.threshold),
      verbose: options.verbose,
    });
  });

program
  .command('watch [path]')
  .description('Watch for file changes and auto-reindex')
  .option('--pattern <glob>', 'File pattern to match', '**/*.md')
  .option('--daemon', 'Start as background daemon')
  .option('--stop', 'Stop watch daemon')
  .option('--status', 'Show watch daemon status')
  .option('--daemon-worker', 'Internal: run daemon worker')
  .action(async (targetPath, options) => {
    const { stopWatchDaemon, watchDaemonStatus, runWatchDaemonWorker } = await import('./commands/watch.js');

    if (options.stop) {
      await stopWatchDaemon();
      return;
    }

    if (options.status) {
      await watchDaemonStatus();
      return;
    }

    if (options.daemonWorker) {
      // Internal: called by daemon process
      await runWatchDaemonWorker(targetPath, options.pattern);
      return;
    }

    watch(targetPath, {
      pattern: options.pattern,
      daemon: options.daemon,
    });
  });

program
  .command('config')
  .description('Interactive configuration wizard')
  .action(config);

program
  .command('memories')
  .description('List and search memories')
  .option('--recent <number>', 'Show N most recent memories')
  .option('-s, --search <query>', 'Search memories semantically')
  .option('--tags <tags>', 'Filter by tags (comma-separated)')
  .option('-n, --limit <number>', 'Maximum number of results', '10')
  .option('-g, --global', 'Use global memory (shared across projects)')
  .option('--json', 'Output as JSON (for scripting)')
  .action((options) => {
    memories({
      recent: options.recent ? parseInt(options.recent, 10) : undefined,
      search: options.search,
      tags: options.tags,
      limit: parseInt(options.limit, 10),
      global: options.global,
      json: options.json,
    });
  });

program
  .command('remember <content>')
  .description('Save something to memory')
  .option('--tags <tags>', 'Tags (comma-separated)')
  .option('--source <source>', 'Source context')
  .option('-g, --global', 'Save to global memory (shared across projects)')
  .option('--skip-quality', 'Skip quality scoring and threshold check')
  .action((content, options) => {
    remember(content, {
      tags: options.tags,
      source: options.source,
      global: options.global,
      skipQuality: options.skipQuality,
    });
  });

program
  .command('index-code [path]')
  .description('Index source code for semantic search')
  .option(
    '--patterns <patterns>',
    'File patterns (comma-separated)',
    '**/*.ts,**/*.tsx,**/*.js,**/*.jsx,**/*.py,**/*.go'
  )
  .option('--ignore <patterns>', 'Ignore patterns (comma-separated)')
  .option('-f, --force', 'Force reindex all files')
  .option('--max-size <kb>', 'Max file size in KB', '500')
  .action((targetPath, options) => {
    indexCode(targetPath, {
      patterns: options.patterns?.split(','),
      ignore: options.ignore?.split(','),
      force: options.force,
      maxFileSize: parseInt(options.maxSize, 10),
    });
  });

program
  .command('forget')
  .description('Delete memories')
  .option('--id <id>', 'Delete memory by ID')
  .option('--older-than <date>', 'Delete memories older than (e.g., "30d", "1w", "3m")')
  .option('--tag <tag>', 'Delete memories with tag')
  .option('--all', 'Delete ALL memories')
  .action((options) => {
    forget({
      id: options.id ? parseInt(options.id, 10) : undefined,
      olderThan: options.olderThan,
      tag: options.tag,
      all: options.all,
    });
  });

program
  .command('benchmark')
  .description('Run performance benchmarks')
  .option('-n, --iterations <number>', 'Number of iterations per test', '10')
  .action((options) => {
    benchmark({
      iterations: parseInt(options.iterations, 10),
    });
  });

program
  .command('benchmark-quality')
  .description('Run quality scoring benchmark (heuristic vs ONNX vs Ollama vs OpenRouter)')
  .option('--ollama', 'Include Ollama models in benchmark')
  .option('--openrouter', 'Include OpenRouter API models in benchmark')
  .option('--models <models>', 'Models to test (comma-separated)')
  .option('--ollama-url <url>', 'Ollama API URL', 'http://localhost:11434')
  .action((options) => {
    benchmarkQuality({
      ollama: options.ollama,
      openrouter: options.openrouter,
      models: options.models,
      ollamaUrl: options.ollamaUrl,
    });
  });

program
  .command('clear')
  .description('Clear index and/or memories')
  .option('--index-only', 'Clear only document index')
  .option('--memories-only', 'Clear only memories')
  .option('--code-only', 'Clear only code index (keeps brain docs)')
  .option('-f, --force', 'Confirm deletion (required)')
  .action((options) => {
    clear({
      indexOnly: options.indexOnly,
      memoriesOnly: options.memoriesOnly,
      codeOnly: options.codeOnly,
      force: options.force,
    });
  });

program
  .command('soul')
  .description('Generate personalized soul.md from project analysis')
  .option('--openrouter', 'Use OpenRouter API instead of Claude CLI')
  .action((options) => {
    soul({
      openrouter: options.openrouter,
    });
  });

program
  .command('graph <action>')
  .description('Knowledge graph: export (to Obsidian), stats, auto-link')
  .option('-f, --format <format>', 'Export format: obsidian or json', 'obsidian')
  .option('-t, --threshold <number>', 'Similarity threshold for auto-link', '0.75')
  .option('-o, --output <path>', 'Output directory for export')
  .action((action, options) => {
    graph({
      action: action as 'export' | 'stats' | 'auto-link',
      format: options.format,
      threshold: parseFloat(options.threshold),
      output: options.output,
    });
  });

program.parse();

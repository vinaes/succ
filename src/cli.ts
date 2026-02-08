#!/usr/bin/env node

import { Command } from 'commander';
import { createRequire } from 'module';
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
import { benchmark, benchmarkExisting, benchmarkWithHistory, listBenchmarkHistory } from './commands/benchmark.js';
import { benchmarkQuality } from './commands/benchmark-quality.js';
import { benchmarkSqliteVec } from './commands/benchmark-sqlite-vec.js';
import { clear } from './commands/clear.js';
import { soul } from './commands/soul.js';
import { graph } from './commands/graph.js';
import { consolidate } from './commands/consolidate.js';
import { sessionSummary } from './commands/session-summary.js';
import { precomputeContext } from './commands/precompute-context.js';
import { trainBPE } from './commands/train-bpe.js';
import { stats } from './commands/stats.js';
import { retention } from './commands/retention.js';
import { checkpoint } from './commands/checkpoint.js';
import { score } from './commands/score.js';
import { daemon } from './commands/daemon.js';
import { migrate } from './commands/migrate.js';
import { setup } from './commands/setup.js';
import { agentsMd } from './commands/agents-md.js';
import { progress } from './commands/progress.js';
import { backfill } from './commands/backfill.js';
import { prdGenerate, prdParse, prdRun, prdList, prdStatus, prdArchive } from './commands/prd.js';

// Read version from package.json
const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const VERSION = pkg.version;

const program = new Command();

program
  .name('succ')
  .version(VERSION)
  .configureHelp({ sortSubcommands: true })
  .addHelpText('beforeAll', `
  \x1b[32m●\x1b[0m succ

  Semantic Understanding for Code Contexts
  Claude Code · Cursor · Windsurf · Continue.dev

  ─────────────────────────────────────────────────────────
`);

program
  .command('init')
  .description('Initialize succ in current project')
  .option('-f, --force', 'Overwrite existing configuration')
  .option('-y, --yes', 'Non-interactive mode (skip prompts)')
  .option('-v, --verbose', 'Show detailed output (created files, etc.)')
  .option('-g, --global', 'Use global hooks (from succ package dir, not local copies)')
  .option('--ai', 'Use AI-powered interactive onboarding instead of static wizard')
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
  .command('add <file>', { hidden: true })
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
  .option('--fast', 'Fast analysis (fewer agents, smaller context)')
  .option('--force', 'Force full re-analysis (skip incremental cache)')
  .action(async (options) => {
    analyze({
      parallel: !options.sequential,
      openrouter: options.openrouter,
      local: options.local,
      background: options.background,
      fast: options.fast,
      force: options.force,
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
  .description('Watch for file changes and auto-reindex (docs + code by default)')
  .option('--pattern <glob>', 'File pattern to match for docs', '**/*.md')
  .option('--ignore-code', 'Skip watching source code files (watch docs only)')
  .option('--stop', 'Stop watch service')
  .option('--status', 'Show watch service status')
  .action(async (targetPath, options) => {
    const { stopWatchDaemon, watchDaemonStatus } = await import('./commands/watch.js');

    if (options.stop) {
      await stopWatchDaemon();
      return;
    }

    if (options.status) {
      await watchDaemonStatus();
      return;
    }

    // Code watching is ON by default, --ignore-code turns it off
    const includeCode = !options.ignoreCode;

    watch(targetPath, {
      pattern: options.pattern,
      includeCode,
    });
  });

program
  .command('config')
  .description('Show or edit succ configuration')
  .option('-s, --show', 'Show current configuration (non-interactive)')
  .option('--json', 'Output as JSON (with --show)')
  .action((options) => {
    config({
      show: options.show,
      json: options.json,
    });
  });

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
  .description('Save something to memory (uses LLM extraction by default)')
  .option('--tags <tags>', 'Tags (comma-separated)')
  .option('--source <source>', 'Source context')
  .option('-g, --global', 'Save to global memory (shared across projects)')
  .option('--skip-quality', 'Skip quality scoring and threshold check')
  .option('--skip-sensitive', 'Skip sensitive info check (not recommended)')
  .option('--redact-sensitive', 'Auto-redact sensitive info and save')
  .option('--valid-from <date>', 'When fact becomes valid (e.g., "2024-01-01" or "7d")')
  .option('--valid-until <date>', 'When fact expires (e.g., "2024-12-31" or "30d")')
  .option('-e, --extract', 'Force LLM extraction (default: enabled)')
  .option('--no-extract', 'Disable LLM extraction (save content as-is)')
  .option('--local', 'Use local LLM (Ollama/LM Studio) for extraction')
  .option('--openrouter', 'Use OpenRouter for extraction')
  .option('--model <model>', 'Model to use for extraction')
  .option('--api-url <url>', 'API URL for local LLM')
  .action((content, options) => {
    remember(content, {
      tags: options.tags,
      source: options.source,
      global: options.global,
      skipQuality: options.skipQuality,
      skipSensitiveCheck: options.skipSensitive,
      redactSensitive: options.redactSensitive,
      validFrom: options.validFrom,
      validUntil: options.validUntil,
      extract: options.extract === true ? true : undefined,
      noExtract: options.extract === false,
      local: options.local,
      openrouter: options.openrouter,
      model: options.model,
      apiUrl: options.apiUrl,
    });
  });

program
  .command('index-code [path]')
  .description('Index source code for semantic search')
  .option('--file <file>', 'Index a single file directly')
  .option(
    '--patterns <patterns>',
    'File patterns (comma-separated)',
    '**/*.ts,**/*.tsx,**/*.js,**/*.jsx,**/*.py,**/*.go'
  )
  .option('--ignore <patterns>', 'Ignore patterns (comma-separated)')
  .option('-f, --force', 'Force reindex all files')
  .option('--max-size <kb>', 'Max file size in KB', '500')
  .action(async (targetPath, options) => {
    // Single file mode
    if (options.file) {
      const { indexCodeFile } = await import('./commands/index-code.js');
      const result = await indexCodeFile(options.file, { force: options.force });
      if (result.success) {
        if (result.skipped) {
          console.log(`Skipped: ${result.reason}`);
        } else {
          console.log(`Indexed ${result.chunks} chunks from ${options.file}`);
        }
      } else {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }
      return;
    }
    // Directory/pattern mode
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
  .option('--advanced', 'Run advanced IR metrics (Recall@K, Precision@K, F1@K, MRR, NDCG)')
  .option('-k, --k <number>', 'K value for metrics', '5')
  .option('--json', 'Output results as JSON')
  .option('--existing', 'Benchmark on existing memories (latency only)')
  .option('-m, --model <model>', 'Local embedding model (e.g., Xenova/bge-base-en-v1.5)')
  .option('--size <size>', 'Dataset size: small (20), medium (64), large (all)', 'small')
  .option('--save', 'Save results to benchmark history')
  .option('--compare', 'Compare with previous benchmark')
  .option('--hybrid', 'Include hybrid search comparison (semantic vs BM25 vs RRF)')
  .option('--history', 'List benchmark history')
  .option('--history-limit <n>', 'Number of history entries to show', '10')
  .action((options) => {
    if (options.history) {
      listBenchmarkHistory({
        limit: parseInt(options.historyLimit, 10),
        json: options.json,
      });
    } else if (options.existing) {
      benchmarkExisting({
        k: parseInt(options.k, 10),
        json: options.json,
      });
    } else if (options.save || options.compare || options.hybrid) {
      benchmarkWithHistory({
        iterations: parseInt(options.iterations, 10),
        advanced: options.advanced,
        k: parseInt(options.k, 10),
        json: options.json,
        model: options.model,
        size: options.size as 'small' | 'medium' | 'large',
        save: options.save,
        compare: options.compare,
        hybrid: options.hybrid,
      });
    } else {
      benchmark({
        iterations: parseInt(options.iterations, 10),
        advanced: options.advanced,
        k: parseInt(options.k, 10),
        json: options.json,
        model: options.model,
        size: options.size as 'small' | 'medium' | 'large',
      });
    }
  });

program
  .command('benchmark-quality', { hidden: true })
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
  .command('benchmark-vec', { hidden: true })
  .description('Compare brute-force vs sqlite-vec indexed vector search')
  .option('--sizes <sizes>', 'Vector counts to test (comma-separated)', '100,500,1000,5000')
  .option('-q, --queries <number>', 'Number of queries per size', '50')
  .option('-k <number>', 'Top-K results to retrieve', '10')
  .option('-m, --model <model>', 'Local embedding model')
  .option('--json', 'Output results as JSON')
  .action((options) => {
    benchmarkSqliteVec({
      sizes: options.sizes.split(',').map((s: string) => parseInt(s, 10)),
      queries: parseInt(options.queries, 10),
      k: parseInt(options.k, 10),
      model: options.model,
      json: options.json,
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

program
  .command('consolidate')
  .description('Consolidate memories: merge duplicates, soft-invalidate redundant')
  .option('--dry-run', 'Preview changes without applying them')
  .option('-t, --threshold <number>', 'Similarity threshold for consolidation (0-1)', '0.85')
  .option('-n, --limit <number>', 'Maximum pairs to process', '50')
  .option('--stats', 'Show consolidation statistics only')
  .option('-v, --verbose', 'Show detailed output')
  .option('--llm', 'Force LLM merge (default: enabled)')
  .option('--no-llm', 'Disable LLM merge (use simple quality-based merge)')
  .option('--undo <id>', 'Undo a consolidation by restoring original memories')
  .option('--history', 'Show recent consolidation operations')
  .action((options) => {
    consolidate({
      dryRun: options.dryRun,
      threshold: options.threshold,
      limit: options.limit,
      stats: options.stats,
      verbose: options.verbose,
      llm: options.llm === true ? true : undefined,
      noLlm: options.llm === false,
      undo: options.undo,
      history: options.history,
    });
  });

program
  .command('session-summary <transcript>', { hidden: true })
  .description('Extract facts from session transcript and save as memories')
  .option('--dry-run', 'Preview facts without saving')
  .option('-v, --verbose', 'Show detailed output')
  .option('--local', 'Use local LLM (Ollama/llama.cpp)')
  .option('--openrouter', 'Use OpenRouter API')
  .option('--api-url <url>', 'API URL for local LLM')
  .option('--model <model>', 'Model to use')
  .action((transcript, options) => {
    sessionSummary(transcript, {
      dryRun: options.dryRun,
      verbose: options.verbose,
      local: options.local,
      openrouter: options.openrouter,
      apiUrl: options.apiUrl,
      model: options.model,
    });
  });

program
  .command('precompute-context <transcript>', { hidden: true })
  .description('Generate context briefing for next session')
  .option('--dry-run', 'Preview output without saving')
  .option('-v, --verbose', 'Show detailed output')
  .option('--local', 'Use local LLM (Ollama/llama.cpp)')
  .option('--openrouter', 'Use OpenRouter API')
  .action((transcript, options) => {
    precomputeContext(transcript, {
      dryRun: options.dryRun,
      verbose: options.verbose,
      local: options.local,
      openrouter: options.openrouter,
    });
  });

program
  .command('train-bpe', { hidden: true })
  .description('Train BPE vocabulary from indexed code')
  .option('--vocab-size <number>', 'Target vocabulary size', '5000')
  .option('--min-frequency <number>', 'Minimum pair frequency to merge', '2')
  .option('--stats', 'Show current BPE statistics only')
  .action((options) => {
    trainBPE({
      vocabSize: parseInt(options.vocabSize, 10),
      minFrequency: parseInt(options.minFrequency, 10),
      showStats: options.stats,
    });
  });

program
  .command('stats')
  .description('Show succ usage statistics')
  .option('--tokens', 'Show token savings statistics')
  .option('--clear', 'Clear token statistics')
  .option('--model <model>', 'Override model for cost recalculation (opus, sonnet, haiku)')
  .action((options) => {
    stats({
      tokens: options.tokens,
      clear: options.clear,
      model: options.model,
    });
  });

program
  .command('retention')
  .description('Manage memory retention with decay-based cleanup')
  .option('--dry-run', 'Preview what would be deleted')
  .option('--apply', 'Actually delete low-score memories')
  .option('--auto-cleanup', 'Soft-invalidate (not delete) low-score memories')
  .option('-v, --verbose', 'Show detailed analysis')
  .action((options) => {
    retention({
      dryRun: options.dryRun,
      apply: options.apply,
      autoCleanup: options.autoCleanup,
      verbose: options.verbose,
    });
  });

program
  .command('backfill')
  .description('Sync existing SQL data (memories, documents) into Qdrant vector store')
  .option('--memories', 'Only backfill project memories')
  .option('--global', 'Only backfill global memories')
  .option('--documents', 'Only backfill documents')
  .option('--dry-run', 'Show counts without writing')
  .action((options) => {
    backfill({
      memories: options.memories,
      global: options.global,
      documents: options.documents,
      dryRun: options.dryRun,
    });
  });

program
  .command('agents-md')
  .description('Generate .claude/AGENTS.md from project memories (decisions, patterns, dead-ends)')
  .option('--preview', 'Preview without writing to disk')
  .option('--path <path>', 'Custom output path')
  .action((options) => {
    agentsMd({
      preview: options.preview,
      path: options.path,
    });
  });

program
  .command('progress')
  .description('View session progress log (knowledge growth over time)')
  .option('-n, --limit <number>', 'Number of entries to show', '20')
  .option('--since <duration>', 'Show entries since (e.g., 7d, 1w, 1m)')
  .action((options) => {
    progress({
      limit: parseInt(options.limit, 10),
      since: options.since,
    });
  });

program
  .command('checkpoint <action> [file]')
  .description('Create, restore, or list checkpoints (full backup/restore)')
  .option('-o, --output <path>', 'Output file path for create')
  .option('--compress', 'Compress with gzip')
  .option('--no-brain', 'Exclude brain vault from create')
  .option('--no-documents', 'Exclude indexed documents from create')
  .option('--no-config', 'Exclude config from create')
  .option('--overwrite', 'Overwrite existing data on restore')
  .option('--restore-config', 'Also restore config on restore')
  .action((action, file, options) => {
    checkpoint({
      action: action as 'create' | 'restore' | 'list' | 'info',
      file,
      output: options.output,
      compress: options.compress,
      includeBrain: options.brain,
      includeDocuments: options.documents,
      includeConfig: options.config,
      overwrite: options.overwrite,
      restoreBrain: options.brain,
      restoreDocuments: options.documents,
      restoreConfig: options.restoreConfig,
    });
  });

program
  .command('score')
  .description('Show AI-readiness score for the project')
  .option('--json', 'Output as JSON')
  .action((options) => {
    score({
      json: options.json,
    });
  });

program
  .command('daemon [subcommand]')
  .description('Manage the succ daemon (status, sessions, start, stop, logs)')
  .option('--json', 'Output as JSON')
  .option('--force', 'Force stop even if sessions active')
  .option('--lines <number>', 'Number of log lines to show', '50')
  .option('--all', 'Include service sessions in list')
  .action((subcommand, options) => {
    daemon(subcommand || 'status', {
      json: options.json,
      force: options.force,
      lines: parseInt(options.lines, 10),
      all: options.all,
    });
  });

program
  .command('migrate')
  .description('Migrate data between storage backends (SQLite, PostgreSQL)')
  .option('--to <backend>', 'Target backend (sqlite or postgresql)')
  .option('--export <file>', 'Export data to JSON file')
  .option('--import <file>', 'Import data from JSON file')
  .option('--dry-run', 'Preview without making changes')
  .option('--force', 'Confirm destructive operations')
  .action((options) => {
    migrate({
      to: options.to as 'sqlite' | 'postgresql' | undefined,
      export: options.export,
      import: options.import,
      dryRun: options.dryRun,
      force: options.force,
    });
  });

program
  .command('setup [editor]')
  .description('Configure succ MCP server for an editor (claude, cursor, windsurf, continue)')
  .option('--detect', 'Auto-detect installed editors and configure all')
  .action((editor, options) => {
    setup({
      editor,
      detect: options.detect,
    });
  });

// PRD Pipeline
const prdCmd = program
  .command('prd')
  .description('PRD-to-Task pipeline — generate, parse, and manage PRDs');

prdCmd
  .command('generate <description>')
  .description('Generate a PRD from a feature description')
  .option('--mode <mode>', 'Execution mode (loop or team)', 'loop')
  .option('--gates <gates>', 'Quality gates (comma-separated, e.g. "typecheck,test")')
  .option('--model <model>', 'LLM model override')
  .option('--auto-parse', 'Automatically parse PRD into tasks')
  .action((description, options) => {
    prdGenerate(description, {
      mode: options.mode,
      gates: options.gates,
      model: options.model,
      autoParse: options.autoParse,
    });
  });

prdCmd
  .command('parse <file-or-id>')
  .description('Parse a PRD markdown into executable tasks')
  .option('--prd-id <id>', 'Add tasks to an existing PRD')
  .option('--dry-run', 'Show tasks without saving')
  .action((fileOrId, options) => {
    prdParse(fileOrId, {
      prdId: options.prdId,
      dryRun: options.dryRun,
    });
  });

prdCmd
  .command('run [prd-id]')
  .description('Execute PRD tasks with Claude Code agent')
  .option('--resume', 'Resume from previous execution')
  .option('--task <task-id>', 'Run a specific task only')
  .option('--dry-run', 'Show execution plan without running')
  .option('--max-iterations <num>', 'Max full-PRD retries (default: 3)')
  .option('--no-branch', 'Execute in current branch (no isolation)')
  .option('--model <model>', 'Claude model override (default: sonnet)')
  .option('--force', 'Force resume even if another runner may be active')
  .option('--mode <mode>', 'Execution mode: loop (sequential) or team (parallel)', 'loop')
  .option('--concurrency <num>', 'Max parallel workers in team mode (default: 3)')
  .action((prdId, options) => {
    prdRun(prdId, {
      resume: options.resume,
      task: options.task,
      dryRun: options.dryRun,
      maxIterations: options.maxIterations,
      noBranch: options.noBranch,
      model: options.model,
      force: options.force,
      mode: options.mode,
      concurrency: options.concurrency,
    });
  });

prdCmd
  .command('list')
  .description('List all PRDs')
  .option('--all', 'Include archived PRDs')
  .action((options) => {
    prdList({ all: options.all });
  });

prdCmd
  .command('status [prd-id]')
  .description('Show PRD status and tasks')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Show detailed task info')
  .action((prdId, options) => {
    prdStatus(prdId, {
      json: options.json,
      verbose: options.verbose,
    });
  });

prdCmd
  .command('archive [prd-id]')
  .description('Archive a PRD (set status to archived)')
  .option('--prd-id <id>', 'PRD ID to archive (or use positional argument)')
  .action((prdId, options) => {
    prdArchive(prdId || options.prdId);
  });

program.parse();

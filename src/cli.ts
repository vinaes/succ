#!/usr/bin/env node

import { Command } from 'commander';
import { init } from './commands/init.js';
import { index } from './commands/index.js';
import { search } from './commands/search.js';
import { status } from './commands/status.js';
import { analyze } from './commands/analyze.js';

const program = new Command();

program
  .name('succ')
  .description('Semantic Understanding for Claude Code - local memory system')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize succ in current project')
  .option('-f, --force', 'Overwrite existing configuration')
  .action(init);

program
  .command('index [path]')
  .description('Index files for semantic search')
  .option('-r, --recursive', 'Index recursively', true)
  .option('--pattern <glob>', 'File pattern to match', '**/*.md')
  .action(index);

program
  .command('search <query>')
  .description('Semantic search across indexed content')
  .option('-n, --limit <number>', 'Number of results', '5')
  .option('-t, --threshold <number>', 'Similarity threshold (0-1)', '0.5')
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
  .action((options) => {
    analyze({
      parallel: !options.sequential,
      openrouter: options.openrouter,
    });
  });

program.parse();

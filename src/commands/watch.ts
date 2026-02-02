import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import chokidar from 'chokidar';
import { getClaudeDir, getProjectRoot, getConfig } from '../lib/config.js';
import { getEmbeddings } from '../lib/embeddings.js';
import { chunkText, extractFrontmatter } from '../lib/chunker.js';
import { withLock } from '../lib/lock.js';
import {
  upsertDocumentsBatch,
  deleteDocumentsByPath,
  getFileHash,
  setFileHash,
  deleteFileHash,
  closeDb,
} from '../lib/db.js';
import { indexCodeFile } from './index-code.js';

/**
 * Code file extensions to watch.
 * Based on GitHub Linguist (https://github.com/github-linguist/linguist)
 * Covers most common programming languages used in production.
 */
const CODE_EXTENSIONS = new Set([
  // JavaScript/TypeScript ecosystem
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
  '.coffee', '.litcoffee', '.es6', '.es',

  // Python
  '.py', '.pyw', '.pyi', '.pyx', '.pxd', '.pxi', '.gyp', '.gypi',

  // Java/JVM languages
  '.java', '.kt', '.kts', '.ktm', '.scala', '.sc', '.sbt',
  '.groovy', '.gradle', '.gvy', '.gy', '.gsh',
  '.clj', '.cljs', '.cljc', '.edn',

  // C/C++/Objective-C
  '.c', '.h', '.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++',
  '.ino', '.ipp', '.ixx', '.tcc', '.tpp', '.inl',
  '.m', '.mm',  // Objective-C

  // C#/.NET
  '.cs', '.csx', '.cake', '.fs', '.fsi', '.fsx', '.fsscript', '.vb',

  // Go
  '.go',

  // Rust
  '.rs', '.rlib',

  // Ruby
  '.rb', '.rake', '.gemspec', '.ru', '.erb', '.builder', '.podspec',

  // PHP
  '.php', '.php3', '.php4', '.php5', '.php7', '.php8', '.phtml', '.inc',

  // Swift
  '.swift',

  // Kotlin (Android)
  '.kt', '.kts',

  // Lua
  '.lua', '.luau', '.nse', '.p8', '.rockspec',

  // Perl
  '.pl', '.pm', '.pod', '.t', '.psgi',

  // Shell/Bash
  '.sh', '.bash', '.zsh', '.fish', '.ksh', '.csh', '.tcsh',
  '.bashrc', '.bash_profile', '.zshrc', '.profile',

  // PowerShell
  '.ps1', '.psm1', '.psd1',

  // SQL
  '.sql', '.pgsql', '.plsql', '.plpgsql', '.mysql',

  // Dart/Flutter
  '.dart',

  // Elixir/Erlang
  '.ex', '.exs', '.erl', '.hrl', '.app.src',

  // Haskell
  '.hs', '.lhs', '.hsc',

  // OCaml/F#/ML
  '.ml', '.mli', '.mll', '.mly', '.eliom', '.eliomi',

  // Lisp/Scheme/Racket
  '.lisp', '.lsp', '.cl', '.el', '.scm', '.ss', '.rkt',

  // Julia
  '.jl',

  // R
  '.r', '.R', '.rmd', '.Rmd',

  // Nim
  '.nim', '.nims', '.nimble',

  // Zig
  '.zig',

  // V
  '.v', '.vv',

  // Crystal
  '.cr',

  // D
  '.d', '.di',

  // Assembly
  '.asm', '.s', '.S', '.nasm',

  // CUDA
  '.cu', '.cuh',

  // WebAssembly
  '.wat', '.wast',

  // Solidity/Web3
  '.sol', '.vyper',

  // Terraform/Infrastructure
  '.tf', '.tfvars', '.hcl',

  // Nix
  '.nix',

  // Dockerfile (no extension usually, handled separately)

  // Config as code
  '.jsonnet', '.libsonnet',
  '.dhall',
  '.cue',

  // GraphQL
  '.graphql', '.gql',

  // Protocol Buffers
  '.proto',

  // Thrift
  '.thrift',

  // Cap'n Proto
  '.capnp',

  // WGSL (WebGPU Shading Language)
  '.wgsl',

  // GLSL/HLSL (Shaders)
  '.glsl', '.vert', '.frag', '.geom', '.tesc', '.tese', '.comp',
  '.hlsl', '.fx', '.fxh',

  // Arduino
  '.ino', '.pde',

  // Makefile (no extension usually)

  // CMake
  '.cmake',

  // Meson
  '.meson',
]);

// Doc file extensions to watch
const DOC_EXTENSIONS = new Set([
  '.md', '.mdx', '.markdown', '.mdown', '.mkd', '.mkdn',
  '.txt', '.text',
  '.rst', '.rest',
  '.adoc', '.asciidoc', '.asc',
  '.org',
  '.tex', '.latex',
]);

interface WatchOptions {
  pattern?: string;
  daemon?: boolean;
  includeCode?: boolean;  // Also watch code files
}

function computeHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Index a single file with lock protection
 */
async function indexFile(filePath: string, relativePath: string, log?: (msg: string) => void): Promise<void> {
  const print = log || console.log;

  // Read file content outside of lock (I/O can be slow)
  const content = fs.readFileSync(filePath, 'utf-8');
  const hash = computeHash(content);

  // Check hash outside of lock first (fast path)
  const existingHash = getFileHash(relativePath);
  if (existingHash === hash) {
    return;
  }

  const { frontmatter, body } = extractFrontmatter(content);

  // Skip if marked as no-index
  if (frontmatter['succ-ignore']) {
    print(`  Skipping ${relativePath} (succ-ignore)`);
    return;
  }

  // Chunk text (CPU-bound, do outside lock)
  const chunks = chunkText(body, relativePath);
  if (chunks.length === 0) return;

  // Get embeddings (network I/O, do outside lock)
  const texts = chunks.map((c) => c.content);
  const embeddings = await getEmbeddings(texts);

  // Prepare documents
  const documents = chunks.map((chunk, i) => ({
    filePath: relativePath,
    chunkIndex: i,
    content: chunk.content,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    embedding: embeddings[i],
  }));

  // Database operations with lock protection
  await withLock('watch-index', async () => {
    // Re-check hash inside lock (file may have changed during embedding)
    const currentHash = getFileHash(relativePath);
    if (currentHash === hash) {
      return; // Another process already indexed this version
    }

    // Delete existing chunks and insert new ones atomically
    deleteDocumentsByPath(relativePath);
    upsertDocumentsBatch(documents);
    setFileHash(relativePath, hash);
  });

  print(`  Indexed: ${relativePath} (${chunks.length} chunks)`);
}

/**
 * Remove a file from index with lock protection
 */
async function removeFile(relativePath: string, log?: (msg: string) => void): Promise<void> {
  const print = log || console.log;

  await withLock('watch-remove', async () => {
    deleteDocumentsByPath(relativePath);
    deleteFileHash(relativePath);
  });

  print(`  Removed: ${relativePath}`);
}

/**
 * Get file type based on extension
 */
function getFileType(filePath: string): 'code' | 'doc' | 'unknown' {
  const ext = path.extname(filePath).toLowerCase();
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (DOC_EXTENSIONS.has(ext)) return 'doc';
  return 'unknown';
}

/**
 * Index a code file with lock protection
 */
async function indexCode(absolutePath: string, relativePath: string, log?: (msg: string) => void): Promise<void> {
  const print = log || console.log;

  try {
    const result = await indexCodeFile(absolutePath);
    if (result.skipped) {
      print(`  Skipped: ${relativePath} (${result.reason})`);
    } else if (result.success) {
      print(`  Indexed: ${relativePath} (${result.chunks} chunks)`);
    } else if (result.error) {
      print(`  Error: ${relativePath} - ${result.error}`);
    }
  } catch (error) {
    print(`  Error indexing code ${relativePath}: ${error}`);
  }
}

/**
 * Remove a code file from index
 */
async function removeCodeFile(relativePath: string, log?: (msg: string) => void): Promise<void> {
  const print = log || console.log;
  const storedPath = `code:${relativePath}`;

  await withLock('watch-remove-code', async () => {
    deleteDocumentsByPath(storedPath);
    deleteFileHash(storedPath);
  });

  print(`  Removed: ${relativePath}`);
}

/**
 * Check if a process is running by PID
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start watch daemon
 */
export async function startWatchDaemon(
  targetPath?: string,
  pattern: string = '**/*.md',
  includeCode: boolean = false
): Promise<void> {
  const claudeDir = getClaudeDir();
  const pidFile = path.join(claudeDir, 'watch.pid');
  const logFile = path.join(claudeDir, 'watch.log');

  // Check if daemon is already running
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (isProcessRunning(pid)) {
      console.log(`👁️  Watch daemon already running (PID: ${pid})`);
      console.log(`   Log: ${logFile}`);
      console.log(`   Stop: succ watch --stop`);
      console.log(`   Status: succ watch --status`);
      return;
    } else {
      // Stale pid file, remove it
      fs.unlinkSync(pidFile);
    }
  }

  console.log('👁️  Starting watch daemon...');

  // Spawn detached process that runs the actual watcher
  // Note: --ignore-code is passed when code watching is disabled (default is ON)
  const args = [
    process.argv[1],
    'watch',
    '--daemon-worker',
    '--pattern', pattern,
    ...(!includeCode ? ['--ignore-code'] : []),
  ];
  if (targetPath) {
    args.push(targetPath);
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
    cwd: getProjectRoot(),
  });

  // Write PID file
  fs.writeFileSync(pidFile, String(child.pid));

  child.unref();

  console.log(`   PID: ${child.pid}`);
  console.log(`   Log: ${logFile}`);
  console.log(`   Pattern: ${pattern}`);
  console.log(`   Code: ${includeCode ? 'enabled' : 'disabled'}`);
  console.log(`\n   Stop:   succ watch --stop`);
  console.log(`   Status: succ watch --status`);
}

/**
 * Stop watch daemon
 */
export async function stopWatchDaemon(): Promise<void> {
  const claudeDir = getClaudeDir();
  const pidFile = path.join(claudeDir, 'watch.pid');

  if (!fs.existsSync(pidFile)) {
    console.log('No watch daemon running');
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);

  if (isProcessRunning(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`👁️  Watch daemon stopped (PID: ${pid})`);
    } catch (error) {
      console.error(`Failed to stop daemon: ${error}`);
    }
  } else {
    console.log('Watch daemon was not running (stale PID file)');
  }

  fs.unlinkSync(pidFile);
}

/**
 * Show watch daemon status
 */
export async function watchDaemonStatus(): Promise<void> {
  const claudeDir = getClaudeDir();
  const pidFile = path.join(claudeDir, 'watch.pid');
  const logFile = path.join(claudeDir, 'watch.log');

  console.log('👁️  Watch Daemon Status\n');

  // Check daemon
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (isProcessRunning(pid)) {
      console.log(`   Status: Running (PID: ${pid})`);
    } else {
      console.log('   Status: Not running (stale PID file)');
      fs.unlinkSync(pidFile);
    }
  } else {
    console.log('   Status: Not running');
  }

  // Show recent log entries
  if (fs.existsSync(logFile)) {
    console.log(`\n   Log file: ${logFile}`);
    const logContent = fs.readFileSync(logFile, 'utf-8');
    const lines = logContent.trim().split('\n');
    const recentLines = lines.slice(-10);
    if (recentLines.length > 0) {
      console.log('\n   Recent activity:');
      for (const line of recentLines) {
        console.log(`   ${line}`);
      }
    }
  }
}

/**
 * Run as daemon worker (internal, called by daemon process)
 */
export async function runWatchDaemonWorker(
  targetPath?: string,
  pattern: string = '**/*.md',
  includeCode: boolean = false
): Promise<void> {
  const projectRoot = getProjectRoot();
  const claudeDir = getClaudeDir();
  const logFile = path.join(claudeDir, 'watch.log');

  const log = (msg: string) => {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}`;
    fs.appendFileSync(logFile, line + '\n');
    console.log(line);
  };

  // Determine what to watch
  const brainPath = path.join(claudeDir, 'brain');
  const watchPaths: string[] = [];

  // Watch brain directory for docs
  if (targetPath) {
    watchPaths.push(path.resolve(targetPath));
  } else if (fs.existsSync(brainPath)) {
    watchPaths.push(brainPath);
  }

  // Watch project root for code if enabled
  if (includeCode) {
    watchPaths.push(projectRoot);
  }

  if (watchPaths.length === 0) {
    log(`Error: No valid paths to watch`);
    process.exit(1);
  }

  log(`👁️  Watch daemon started`);
  for (const wp of watchPaths) {
    const displayPath = path.relative(projectRoot, wp) || wp;
    log(`   Watching: ${displayPath}`);
  }
  log(`   Doc pattern: ${pattern}`);
  if (includeCode) {
    log(`   Code: enabled`);
  }

  // Debounce map to avoid multiple rapid triggers
  const pending = new Map<string, NodeJS.Timeout>();
  const debounceMs = 500;

  // Comprehensive ignore patterns
  // Based on GitHub gitignore templates (https://github.com/github/gitignore)
  const ignoredPatterns = [
    // Version control
    '**/.git/**',
    '**/.svn/**',
    '**/.hg/**',

    // Dependencies
    '**/node_modules/**',
    '**/bower_components/**',
    '**/jspm_packages/**',
    '**/web_modules/**',
    '**/vendor/**',              // PHP, Go, Ruby
    '**/.bundle/**',             // Ruby
    '**/Pods/**',                // iOS CocoaPods

    // Python
    '**/__pycache__/**',
    '**/*.py[cod]',
    '**/.venv/**',
    '**/venv/**',
    '**/env/**',
    '**/.eggs/**',
    '**/*.egg-info/**',
    '**/.tox/**',
    '**/.nox/**',
    '**/.pytest_cache/**',
    '**/.mypy_cache/**',
    '**/.ruff_cache/**',

    // JavaScript/TypeScript build
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/.next/**',
    '**/.nuxt/**',
    '**/.output/**',
    '**/.svelte-kit/**',
    '**/.vitepress/**',
    '**/.docusaurus/**',
    '**/.cache/**',
    '**/.parcel-cache/**',
    '**/.turbo/**',

    // Java/JVM
    '**/target/**',              // Maven
    '**/bin/**',                 // Eclipse
    '**/.gradle/**',
    '**/gradle/**',
    '**/*.class',

    // Rust
    // target already covered above
    '**/debug/**',

    // Go
    '**/go/pkg/**',

    // .NET
    '**/obj/**',
    '**/packages/**',
    '**/.vs/**',

    // Minified/bundled files
    '**/*.min.js',
    '**/*.min.css',
    '**/*.bundle.js',
    '**/*.chunk.js',

    // Coverage
    '**/coverage/**',
    '**/.nyc_output/**',
    '**/htmlcov/**',

    // IDE/Editors
    '**/.idea/**',
    '**/.vscode/**',
    '**/.obsidian/**',
    '**/*.swp',
    '**/*.swo',
    '**/*~',

    // OS files
    '**/.DS_Store',
    '**/Thumbs.db',
    '**/desktop.ini',

    // Lock files and logs
    '**/*.log',
    '**/logs/**',
    '**/*.lock',
    '**/package-lock.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
    '**/Gemfile.lock',
    '**/Cargo.lock',
    '**/poetry.lock',
    '**/composer.lock',

    // Environment/secrets
    '**/.env',
    '**/.env.*',
    '**/secrets/**',
    '**/*.pem',
    '**/*.key',

    // Testing
    '**/.hypothesis/**',
    '**/test-results/**',
    '**/playwright-report/**',

    // Documentation build
    '**/docs/_build/**',
    '**/site/**',

    // Temporary
    '**/tmp/**',
    '**/temp/**',
    '**/.tmp/**',

    // succ/Claude specific
    '**/.claude/**',
    '**/.succ/**',

    // Generated
    '**/generated/**',
    '**/*.generated.*',
    '**/*.auto.*',
  ];

  // Build patterns to watch
  const watchPatterns: string[] = [pattern]; // Doc pattern
  if (includeCode) {
    // Add code patterns
    const codeExtensions = Array.from(CODE_EXTENSIONS).map(ext => `**/*${ext}`);
    watchPatterns.push(...codeExtensions);
  }

  // Create a single watcher for all paths and patterns
  const watcher = chokidar.watch(watchPatterns, {
    cwd: projectRoot,
    ignoreInitial: true,
    ignored: ignoredPatterns,
    persistent: true,
  });

  /**
   * Handle file add/change
   */
  const handleFileChange = (file: string, action: '+' | '~') => {
    const absolutePath = path.join(projectRoot, file);
    const relativePath = file;
    const fileType = getFileType(file);

    if (pending.has(relativePath)) {
      clearTimeout(pending.get(relativePath));
    }

    pending.set(
      relativePath,
      setTimeout(async () => {
        pending.delete(relativePath);
        if (!fs.existsSync(absolutePath)) {
          log(`  Skipped ${file} (no longer exists)`);
          return;
        }
        log(`[${action}] ${file}`);
        try {
          if (fileType === 'code') {
            await indexCode(absolutePath, relativePath, log);
          } else if (fileType === 'doc') {
            await indexFile(absolutePath, relativePath, log);
          } else {
            log(`  Skipped ${file} (unknown type)`);
          }
        } catch (error) {
          log(`  Error indexing ${file}: ${error}`);
        }
      }, debounceMs)
    );
  };

  watcher.on('add', (file) => handleFileChange(file, '+'));
  watcher.on('change', (file) => handleFileChange(file, '~'));

  watcher.on('unlink', async (file) => {
    const relativePath = file;
    const fileType = getFileType(file);
    log(`[-] ${file}`);
    try {
      if (fileType === 'code') {
        await removeCodeFile(relativePath, log);
      } else if (fileType === 'doc') {
        await removeFile(relativePath, log);
      }
    } catch (error) {
      log(`  Error removing ${file}: ${error}`);
    }
  });

  watcher.on('error', (error) => {
    log(`Watcher error: ${error}`);
  });

  // Handle termination signals
  const cleanup = () => {
    log('Watch daemon stopping...');
    watcher.close();
    closeDb();
    // Remove PID file
    const pidFile = path.join(claudeDir, 'watch.pid');
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

/**
 * Watch for file changes and auto-reindex (foreground mode)
 */
export async function watch(
  targetPath?: string,
  options: WatchOptions = {}
): Promise<void> {
  const { pattern = '**/*.md', daemon = false, includeCode = false } = options;

  // Daemon mode: start background process
  if (daemon) {
    await startWatchDaemon(targetPath, pattern, includeCode);
    return;
  }

  // Foreground mode: run watcher directly
  const projectRoot = getProjectRoot();
  const claudeDir = getClaudeDir();

  // Default to brain directory
  const watchPath = targetPath
    ? path.resolve(targetPath)
    : path.join(claudeDir, 'brain');

  if (!fs.existsSync(watchPath)) {
    console.error(`Path not found: ${watchPath}`);
    process.exit(1);
  }

  const displayPath = path.relative(projectRoot, watchPath) || watchPath;
  console.log(`Watching ${displayPath}`);
  console.log(`Pattern: ${pattern}`);
  console.log('Press Ctrl+C to stop\n');

  // Debounce map to avoid multiple rapid triggers
  const pending = new Map<string, NodeJS.Timeout>();
  const debounceMs = 500;

  const watcher = chokidar.watch(pattern, {
    cwd: watchPath,
    ignoreInitial: true,
    ignored: ['**/node_modules/**', '**/.git/**', '**/.obsidian/**'],
    persistent: true,
  });

  watcher.on('add', (file) => {
    const absolutePath = path.join(watchPath, file);
    const relativePath = path.relative(projectRoot, absolutePath);

    // Debounce
    if (pending.has(relativePath)) {
      clearTimeout(pending.get(relativePath));
    }

    pending.set(
      relativePath,
      setTimeout(async () => {
        pending.delete(relativePath);
        // Check if file still exists (may have been renamed/deleted during debounce)
        if (!fs.existsSync(absolutePath)) {
          console.log(`  Skipped ${file} (no longer exists)`);
          return;
        }
        console.log(`[+] ${file}`);
        try {
          await indexFile(absolutePath, relativePath);
        } catch (error) {
          console.error(`  Error indexing ${file}:`, error);
        }
      }, debounceMs)
    );
  });

  watcher.on('change', (file) => {
    const absolutePath = path.join(watchPath, file);
    const relativePath = path.relative(projectRoot, absolutePath);

    // Debounce
    if (pending.has(relativePath)) {
      clearTimeout(pending.get(relativePath));
    }

    pending.set(
      relativePath,
      setTimeout(async () => {
        pending.delete(relativePath);
        // Check if file still exists (may have been renamed/deleted during debounce)
        if (!fs.existsSync(absolutePath)) {
          console.log(`  Skipped ${file} (no longer exists)`);
          return;
        }
        console.log(`[~] ${file}`);
        try {
          await indexFile(absolutePath, relativePath);
        } catch (error) {
          console.error(`  Error indexing ${file}:`, error);
        }
      }, debounceMs)
    );
  });

  watcher.on('unlink', async (file) => {
    const absolutePath = path.join(watchPath, file);
    const relativePath = path.relative(projectRoot, absolutePath);

    console.log(`[-] ${file}`);
    try {
      await removeFile(relativePath);
    } catch (error) {
      console.error(`  Error removing ${file}:`, error);
    }
  });

  watcher.on('error', (error) => {
    console.error('Watcher error:', error);
  });

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('\nStopping watcher...');
    watcher.close();
    closeDb();
    process.exit(0);
  });
}

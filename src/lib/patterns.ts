/**
 * Common file patterns for code and documentation indexing.
 *
 * Based on:
 * - GitHub Linguist (https://github.com/github-linguist/linguist)
 * - GitHub gitignore templates (https://github.com/github/gitignore)
 */

/**
 * Code file extensions to index/watch.
 * Covers most common programming languages used in production.
 */
export const CODE_EXTENSIONS = new Set([
  // JavaScript/TypeScript ecosystem
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',

  // Python
  '.py',
  '.pyw',
  '.pyi',

  // Java/JVM languages
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.groovy',

  // C/C++
  '.c',
  '.h',
  '.cpp',
  '.cc',
  '.cxx',
  '.hpp',
  '.hh',

  // C#/.NET
  '.cs',
  '.fs',
  '.vb',

  // Go
  '.go',

  // Rust
  '.rs',

  // Ruby
  '.rb',
  '.rake',

  // PHP
  '.php',

  // Swift
  '.swift',

  // Dart
  '.dart',

  // Shell
  '.sh',
  '.bash',
  '.zsh',

  // Lua
  '.lua',

  // Elixir/Erlang
  '.ex',
  '.exs',
  '.erl',

  // Haskell
  '.hs',

  // SQL
  '.sql',

  // GraphQL
  '.graphql',
  '.gql',
]);

/**
 * Documentation file extensions to index/watch.
 */
export const DOC_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.markdown',
  '.txt',
  '.text',
  '.rst',
  '.adoc',
  '.asciidoc',
]);

/**
 * Default glob patterns for code files.
 */
export const DEFAULT_CODE_PATTERNS = [
  // JavaScript/TypeScript
  '**/*.js',
  '**/*.jsx',
  '**/*.ts',
  '**/*.tsx',
  '**/*.mjs',
  '**/*.cjs',
  '**/*.mts',
  '**/*.cts',

  // Python
  '**/*.py',
  '**/*.pyw',
  '**/*.pyi',

  // Java/JVM
  '**/*.java',
  '**/*.kt',
  '**/*.kts',
  '**/*.scala',
  '**/*.groovy',
  '**/*.gradle',
  '**/*.clj',
  '**/*.cljs',
  '**/*.cljc',

  // C/C++
  '**/*.c',
  '**/*.h',
  '**/*.cpp',
  '**/*.cc',
  '**/*.cxx',
  '**/*.hpp',
  '**/*.hh',
  '**/*.hxx',
  '**/*.ino',

  // C#/.NET
  '**/*.cs',
  '**/*.fs',
  '**/*.fsx',
  '**/*.vb',

  // Go
  '**/*.go',

  // Rust
  '**/*.rs',

  // Ruby
  '**/*.rb',
  '**/*.rake',
  '**/*.gemspec',

  // PHP
  '**/*.php',

  // Swift
  '**/*.swift',

  // Dart
  '**/*.dart',

  // Shell
  '**/*.sh',
  '**/*.bash',
  '**/*.zsh',

  // Lua
  '**/*.lua',

  // Elixir/Erlang
  '**/*.ex',
  '**/*.exs',
  '**/*.erl',

  // Haskell
  '**/*.hs',

  // SQL
  '**/*.sql',
];

/**
 * Directories to ignore (for fast path checking).
 */
export const IGNORE_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'bower_components',
  'jspm_packages',
  'web_modules',
  'vendor',
  '.bundle',
  'Pods',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.eggs',
  '.tox',
  '.nox',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.vitepress',
  '.docusaurus',
  '.cache',
  '.parcel-cache',
  '.turbo',
  'target',
  'bin',
  '.gradle',
  'gradle',
  'debug',
  'obj',
  'packages',
  '.vs',
  'coverage',
  '.nyc_output',
  'htmlcov',
  '.idea',
  '.vscode',
  '.obsidian',
  'logs',
  '.claude',
  'tmp',
  'temp',
  '.tmp',
  '.hypothesis',
  'test-results',
  'playwright-report',
  'docs/_build',
  'site',
  'generated',
]);

/**
 * Default glob ignore patterns.
 */
export const DEFAULT_IGNORE_PATTERNS = [
  // Version control
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',

  // Dependencies
  '**/node_modules/**',
  '**/bower_components/**',
  '**/jspm_packages/**',
  '**/web_modules/**',
  '**/vendor/**',
  '**/.bundle/**',
  '**/Pods/**',

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
  '**/target/**',
  '**/bin/**',
  '**/.gradle/**',
  '**/gradle/**',
  '**/*.class',

  // Rust
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

/**
 * Specific paths to ignore within .succ directory.
 * These are checked separately to allow .succ/brain/** files.
 */
export const IGNORE_SUCC_PATHS = new Set([
  '.tmp',
  'succ.db',
  'succ.db-wal',
  'succ.db-shm',
  'daemon.log',
  'config.json',
]);

/**
 * Get file type based on extension.
 */
export function getFileType(filePath: string): 'code' | 'doc' | null {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (DOC_EXTENSIONS.has(ext)) return 'doc';
  return null;
}

/**
 * Check if a path should be ignored based on directory components.
 * Fast path check without glob matching.
 */
export function shouldIgnorePath(relativePath: string, sep: string = '/'): boolean {
  const parts = relativePath.split(sep);

  // Check each directory component
  for (let i = 0; i < parts.length - 1; i++) {
    if (IGNORE_DIRS.has(parts[i])) {
      return true;
    }
  }

  // Special handling for .succ directory
  if (parts[0] === '.succ') {
    // Allow .succ/brain/** files
    if (parts.length > 1 && parts[1] === 'brain') {
      return false;
    }
    // Ignore specific files in .succ
    if (parts.length === 2 && IGNORE_SUCC_PATHS.has(parts[1])) {
      return true;
    }
    // Ignore .succ/.tmp/**
    if (parts.length > 1 && parts[1] === '.tmp') {
      return true;
    }
    // Allow other .succ files (like soul.md)
    return false;
  }

  // Check filename patterns
  const filename = parts[parts.length - 1];
  if (filename === '.DS_Store' || filename === '.env' || filename.endsWith('.log')) {
    return true;
  }
  if (filename.startsWith('.env.')) {
    return true;
  }

  return false;
}

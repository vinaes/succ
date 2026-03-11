/**
 * LSP Server Definitions — per-language server configuration.
 *
 * Defines how to detect, install, and start LSP servers for each language.
 * Three install strategies: npm, binary download, or runtime check.
 */

import * as fs from 'fs';
import { minimatch } from 'minimatch';

// ============================================================================
// Types
// ============================================================================

export type InstallStrategy =
  | { type: 'npm'; packages: string[] }
  | { type: 'binary'; repo: string; asset: string }
  | { type: 'runtime'; check: string; installCmd: string[]; hint: string };

export interface LspServerConfig {
  /** Human-readable name */
  name: string;
  /** Language IDs this server handles */
  languages: string[];
  /** How to detect if project uses this language */
  rootMarkers: string[];
  /** How to install the server */
  install: InstallStrategy;
  /** Command to start the server */
  command: string;
  /** Arguments for the server command */
  args: string[];
  /** Additional initialization options for the LSP server */
  initializationOptions?: Record<string, unknown>;
  /** Server capabilities to request */
  capabilities?: Record<string, unknown>;
  /** Idle timeout before killing (default: 600000ms = 10min) */
  idleTimeoutMs?: number;
  /** Support tier: 1=auto-install, 2=needs runtime, 3=community */
  tier: 1 | 2 | 3;
}

// ============================================================================
// Server Definitions
// ============================================================================

export const LSP_SERVERS: Record<string, LspServerConfig> = {
  typescript: {
    name: 'TypeScript Language Server',
    languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    install: {
      type: 'npm',
      packages: ['typescript-language-server', 'typescript'],
    },
    command: 'typescript-language-server',
    args: ['--stdio'],
    initializationOptions: {
      preferences: {
        includeInlayParameterNameHints: 'none',
        includeInlayPropertyDeclarationTypeHints: false,
      },
    },
    tier: 1,
  },

  python: {
    name: 'Pyright',
    languages: ['python'],
    rootMarkers: ['pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile'],
    install: {
      type: 'npm',
      packages: ['pyright'],
    },
    command: 'pyright-langserver',
    args: ['--stdio'],
    tier: 1,
  },

  go: {
    name: 'gopls',
    languages: ['go'],
    rootMarkers: ['go.mod', 'go.sum'],
    install: {
      type: 'runtime',
      check: 'go version',
      installCmd: ['go', 'install', 'golang.org/x/tools/gopls@latest'],
      hint: 'Go runtime required. Install from https://go.dev',
    },
    command: 'gopls',
    args: ['serve'],
    tier: 2,
  },

  rust: {
    name: 'rust-analyzer',
    languages: ['rust'],
    rootMarkers: ['Cargo.toml'],
    install: {
      type: 'binary',
      repo: 'rust-lang/rust-analyzer',
      asset: 'rust-analyzer',
    },
    command: 'rust-analyzer',
    args: [],
    tier: 2,
  },

  csharp: {
    name: 'csharp-ls',
    languages: ['csharp'],
    rootMarkers: ['*.csproj', '*.sln'],
    install: {
      type: 'runtime',
      check: 'dotnet --version',
      installCmd: ['dotnet', 'tool', 'install', '--global', 'csharp-ls'],
      hint: '.NET SDK required. Install from https://dotnet.microsoft.com',
    },
    command: 'csharp-ls',
    args: [],
    tier: 2,
  },

  kotlin: {
    name: 'Kotlin Language Server',
    languages: ['kotlin'],
    rootMarkers: [
      'build.gradle',
      'build.gradle.kts',
      'settings.gradle',
      'settings.gradle.kts',
      'pom.xml',
    ],
    install: {
      type: 'binary',
      repo: 'fwcd/kotlin-language-server',
      asset: 'server',
    },
    command: 'kotlin-language-server',
    args: [],
    tier: 2,
  },

  swift: {
    name: 'SourceKit-LSP',
    languages: ['swift'],
    rootMarkers: ['Package.swift', '*.xcodeproj', '*.xcworkspace'],
    install: {
      type: 'runtime',
      check: 'swift --version',
      installCmd: ['xcode-select', '--install'],
      hint: 'Swift toolchain required. Install Xcode or Swift from https://swift.org/download',
    },
    command: 'sourcekit-lsp',
    args: [],
    tier: 2,
  },
};

/**
 * Detect which LSP servers should be used for a project.
 * Checks for root marker files (exact names) and glob-style markers (e.g. "*.csproj").
 *
 * @param rootPath - Absolute path to the project root directory
 * @param existsSync - Predicate to test whether a path exists (injectable for tests)
 * @param readdirSync - Read a directory and return its entry names (injectable for tests)
 */
export function detectProjectLanguages(
  rootPath: string,
  existsSync: (path: string) => boolean,
  readdirSync: (path: string) => string[] = defaultReaddirSync
): string[] {
  const detected: string[] = [];

  for (const [key, config] of Object.entries(LSP_SERVERS)) {
    let found = false;
    for (const marker of config.rootMarkers) {
      if (found) break;

      if (marker.includes('*')) {
        // Glob marker — check whether any file in rootPath matches the pattern.
        const entries = readdirSync(rootPath);
        if (entries.some((name) => minimatch(name, marker, { dot: true, matchBase: true }))) {
          found = true;
        }
      } else {
        // Exact marker file name
        if (existsSync(`${rootPath}/${marker}`)) {
          found = true;
        }
      }
    }
    if (found) {
      detected.push(key);
    }
  }

  return detected;
}

/** Default readdirSync that returns an empty array on error. */
function defaultReaddirSync(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath) as string[];
  } catch {
    return [];
  }
}

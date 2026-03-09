/**
 * Cross-Repo Search — search across multiple projects from one query.
 *
 * Enterprise feature: coordinates per-project searches, merges results
 * with project-level metadata.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logInfo, logWarn } from './fault-logger.js';

// ============================================================================
// Types
// ============================================================================

export interface CrossRepoProject {
  /** Project name (directory name or config name) */
  name: string;
  /** Absolute path to the project root */
  rootPath: string;
  /** Path to the .succ directory */
  succDir: string;
  /** Whether the project has an initialized succ database */
  initialized: boolean;
}

export interface CrossRepoSearchResult {
  /** Source project */
  project: string;
  /** Memory/document content */
  content: string;
  /** Relevance score */
  score: number;
  /** Result type: memory, code, or document */
  type: 'memory' | 'code' | 'document';
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

export interface CrossRepoSearchSummary {
  query: string;
  projectsSearched: number;
  totalResults: number;
  results: CrossRepoSearchResult[];
}

// ============================================================================
// Project Discovery
// ============================================================================

/**
 * Discover all succ-initialized projects on the system.
 * Looks for .succ directories in common locations.
 */
export function discoverProjects(searchPaths?: string[]): CrossRepoProject[] {
  const paths = searchPaths ?? getDefaultSearchPaths();
  const projects: CrossRepoProject[] = [];
  const seen = new Set<string>();

  for (const searchPath of paths) {
    if (!fs.existsSync(searchPath)) continue;

    // Check if searchPath itself is a succ project (e.g. ~/code is a mono-repo root)
    checkProjectDir(searchPath, path.basename(searchPath), seen, projects);

    try {
      const entries = fs.readdirSync(searchPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;

        const depth1Root = path.join(searchPath, entry.name);

        // Depth 1: direct child (e.g. ~/code/myrepo)
        checkProjectDir(depth1Root, entry.name, seen, projects);

        // Depth 2: org/repo layout (e.g. ~/code/org/repo)
        try {
          const subEntries = fs.readdirSync(depth1Root, { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (!subEntry.isDirectory()) continue;
            if (subEntry.name.startsWith('.')) continue;
            const depth2Root = path.join(depth1Root, subEntry.name);
            checkProjectDir(depth2Root, subEntry.name, seen, projects);
          }
        } catch {
          // Ignore unreadable subdirectories
        }
      }
    } catch (error) {
      logWarn('cross-repo', `Failed to scan ${searchPath}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logInfo('cross-repo', `Discovered ${projects.length} succ projects`);
  return projects;
}

/**
 * List all known projects (from global config or discovery).
 */
export function listProjects(searchPaths?: string[]): CrossRepoProject[] {
  return discoverProjects(searchPaths);
}

// ============================================================================
// Internal
// ============================================================================

/**
 * Check if a directory is a succ-initialized project and add it to the list.
 * Avoids double-adding via the `seen` set.
 */
function checkProjectDir(
  projectRoot: string,
  name: string,
  seen: Set<string>,
  projects: CrossRepoProject[]
): void {
  if (seen.has(projectRoot)) return;
  seen.add(projectRoot);

  const succDir = path.join(projectRoot, '.succ');
  const initialized = fs.existsSync(succDir) && fs.existsSync(path.join(succDir, 'succ.db'));

  if (initialized) {
    projects.push({ name, rootPath: projectRoot, succDir, initialized });
  }
}

function getDefaultSearchPaths(): string[] {
  const home = os.homedir();
  const paths = [
    path.join(home, 'projects'),
    path.join(home, 'code'),
    path.join(home, 'src'),
    path.join(home, 'repos'),
    path.join(home, 'dev'),
    path.join(home, 'workspace'),
  ];

  // Windows-specific paths
  if (process.platform === 'win32') {
    paths.push('C:\\dev', 'C:\\projects', 'C:\\src');
  }

  // Linux/Mac development directories
  if (process.platform !== 'win32') {
    paths.push('/opt/projects', '/var/www');
  }

  return paths;
}

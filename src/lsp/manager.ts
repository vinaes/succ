/**
 * LSP Manager — manages LSP server instances per language:root.
 *
 * Lifecycle:
 * 1. Detect project language from marker files
 * 2. Auto-install LSP server if missing (configurable)
 * 3. Spawn server on first query (lazy)
 * 4. Keep server alive across queries (singleton per language:root)
 * 5. Idle timeout: kill after 10 min of inactivity
 * 6. Graceful degradation: LSP unavailable → return null
 */

import * as fs from 'fs';
import * as path from 'path';
import { LspClient, type LspLocation } from './client.js';
import { LSP_SERVERS, detectProjectLanguages, type LspServerConfig } from './servers.js';
import { installServer, isServerInstalled, getServerBinaryPath } from './installer.js';
import { logInfo, logWarn } from '../lib/fault-logger.js';

// ============================================================================
// Types
// ============================================================================

export interface LspQueryResult {
  locations: LspLocation[];
  /** Whether the result came from LSP (true) or null/empty (false = fallback needed) */
  fromLsp: boolean;
  /** Server name that handled the query */
  server?: string;
}

// ============================================================================
// Manager
// ============================================================================

/** Cache key: "language:rootPath" */
type CacheKey = string;

const clients = new Map<CacheKey, LspClient>();
const initializing = new Map<CacheKey, Promise<LspClient | null>>();

/**
 * Get or create an LSP client for a given language and project root.
 *
 * @param language - Language key (e.g. 'typescript', 'python')
 * @param rootPath - Project root directory
 * @param autoInstall - Whether to auto-install if server is missing (default: true)
 */
export async function getClient(
  language: string,
  rootPath: string,
  autoInstall: boolean = true
): Promise<LspClient | null> {
  const key: CacheKey = `${language}:${rootPath}`;

  // Return existing client if ready
  const existing = clients.get(key);
  if (existing?.isReady) return existing;

  // Prevent duplicate initialization
  const pending = initializing.get(key);
  if (pending) return pending;

  const promise = initializeClient(language, rootPath, autoInstall);
  initializing.set(key, promise);

  try {
    const client = await promise;
    if (client) {
      clients.set(key, client);
    }
    return client;
  } finally {
    initializing.delete(key);
  }
}

/**
 * Find definition of a symbol.
 *
 * @param filePath - File containing the symbol
 * @param line - 0-based line number
 * @param character - 0-based character offset
 * @param rootPath - Project root
 */
export async function findDefinition(
  filePath: string,
  line: number,
  character: number,
  rootPath: string
): Promise<LspQueryResult> {
  const language = detectLanguageFromFile(filePath);
  if (!language) return { locations: [], fromLsp: false };

  const client = await getClient(language, rootPath);
  if (!client) return { locations: [], fromLsp: false };

  try {
    const locations = await client.definition(filePath, line, character);
    return { locations, fromLsp: true, server: language };
  } catch (error) {
    logWarn('lsp-manager', `Definition query failed for ${filePath}:${line}:${character}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return { locations: [], fromLsp: false };
  }
}

/**
 * Find all references to a symbol.
 */
export async function findReferences(
  filePath: string,
  line: number,
  character: number,
  rootPath: string,
  includeDeclaration: boolean = true
): Promise<LspQueryResult> {
  const language = detectLanguageFromFile(filePath);
  if (!language) return { locations: [], fromLsp: false };

  const client = await getClient(language, rootPath);
  if (!client) return { locations: [], fromLsp: false };

  try {
    const locations = await client.references(filePath, line, character, includeDeclaration);
    return { locations, fromLsp: true, server: language };
  } catch (error) {
    logWarn('lsp-manager', `References query failed for ${filePath}:${line}:${character}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return { locations: [], fromLsp: false };
  }
}

/**
 * Get hover information.
 */
export async function getHover(
  filePath: string,
  line: number,
  character: number,
  rootPath: string
): Promise<{ content: string | null; fromLsp: boolean }> {
  const language = detectLanguageFromFile(filePath);
  if (!language) return { content: null, fromLsp: false };

  const client = await getClient(language, rootPath);
  if (!client) return { content: null, fromLsp: false };

  try {
    const content = await client.hover(filePath, line, character);
    return { content, fromLsp: true };
  } catch (error) {
    logWarn('lsp-manager', `Hover query failed for ${filePath}:${line}:${character}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return { content: null, fromLsp: false };
  }
}

/**
 * Shutdown all active LSP clients.
 */
export async function shutdownAll(): Promise<void> {
  const shutdowns = Array.from(clients.entries()).map(async ([key, client]) => {
    try {
      await client.shutdown();
    } catch (error) {
      logWarn('lsp-manager', `Failed to shutdown ${key}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await Promise.all(shutdowns);
  clients.clear();
  logInfo('lsp-manager', 'All LSP clients shut down');
}

/**
 * Get status of all active LSP clients.
 */
export function getStatus(): Array<{ key: string; ready: boolean }> {
  return Array.from(clients.entries()).map(([key, client]) => ({
    key,
    ready: client.isReady,
  }));
}

// ============================================================================
// Internal
// ============================================================================

async function initializeClient(
  language: string,
  rootPath: string,
  autoInstall: boolean
): Promise<LspClient | null> {
  const config = LSP_SERVERS[language];
  if (!config) {
    logWarn('lsp-manager', `No LSP server config for language: ${language}`);
    return null;
  }

  // Check if installed
  if (!isServerInstalled(language, config.command)) {
    if (!autoInstall) {
      logInfo('lsp-manager', `${config.name} not installed and auto-install disabled`);
      return null;
    }

    logInfo('lsp-manager', `Auto-installing ${config.name}...`);
    const installed = await installServer(language, config);
    if (!installed) {
      logWarn('lsp-manager', `Failed to auto-install ${config.name}`);
      return null;
    }
  }

  // Get the actual command path
  const command = getServerBinaryPath(language, config.command);

  try {
    const client = new LspClient({
      command,
      args: config.args,
      rootPath,
      initializationOptions: config.initializationOptions,
      idleTimeoutMs: config.idleTimeoutMs,
    });

    await client.start();
    logInfo('lsp-manager', `${config.name} started for ${rootPath}`);
    return client;
  } catch (error) {
    logWarn('lsp-manager', `Failed to start ${config.name}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function detectLanguageFromFile(filePath: string): string | null {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!ext) return null;

  const extMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'typescript',
    jsx: 'typescript',
    py: 'python',
    go: 'go',
    rs: 'rust',
    cs: 'csharp',
  };

  return extMap[ext] ?? null;
}

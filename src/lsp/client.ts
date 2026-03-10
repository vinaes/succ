/**
 * LSP Client — headless LSP connection over JSON-RPC stdio.
 *
 * Manages lifecycle: spawn → initialize → query → shutdown.
 * Uses vscode-languageserver-protocol for typed LSP messages.
 */

import { spawn, type ChildProcess } from 'child_process';
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type ProtocolConnection,
} from 'vscode-languageserver-protocol/node.js';
import {
  InitializeRequest,
  ShutdownRequest,
  ExitNotification,
  DidOpenTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DefinitionRequest,
  ReferencesRequest,
  HoverRequest,
  type InitializeParams,
  type InitializeResult,
  type Location,
  type LocationLink,
  type Hover,
} from 'vscode-languageserver-protocol';
import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logWarn } from '../lib/fault-logger.js';
import { pathToFileURL, fileURLToPath } from 'url';

// ============================================================================
// Types
// ============================================================================

export interface LspClientOptions {
  /** Server command */
  command: string;
  /** Server arguments */
  args: string[];
  /** Project root path */
  rootPath: string;
  /** Initialization options for the server */
  initializationOptions?: Record<string, unknown>;
  /** Idle timeout in ms (default: 600000 = 10 min) */
  idleTimeoutMs?: number;
}

export interface LspLocation {
  uri: string;
  filePath: string;
  line: number;
  character: number;
  endLine?: number;
  endCharacter?: number;
}

// ============================================================================
// Client
// ============================================================================

export class LspClient {
  private process: ChildProcess | null = null;
  private connection: ProtocolConnection | null = null;
  private initialized = false;
  /** Tracks open documents: URI → document version counter */
  private openDocuments = new Map<string, number>();
  /** File watchers for open documents to detect external edits */
  private fileWatchers = new Map<string, fs.FSWatcher>();
  /** Debounce timers for file change events (Windows fires duplicates) */
  private fileChangeTimers = new Map<string, NodeJS.Timeout>();
  private idleTimer: NodeJS.Timeout | null = null;
  /** Single-flight guard: if start() is in progress, concurrent callers share this promise */
  private startingPromise: Promise<InitializeResult> | null = null;
  private readonly idleTimeoutMs: number;
  private readonly options: LspClientOptions;

  constructor(options: LspClientOptions) {
    this.options = options;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 600000;
  }

  /**
   * Start the LSP server process and initialize the connection.
   * Cleans up spawned process and connection on any failure.
   */
  async start(): Promise<InitializeResult> {
    if (this.initialized) {
      throw new Error('LSP client already initialized');
    }

    // Single-flight: if a start() is already in progress, return its promise
    if (this.startingPromise) {
      return this.startingPromise;
    }

    this.startingPromise = this._doStart();
    try {
      return await this.startingPromise;
    } finally {
      this.startingPromise = null;
    }
  }

  private async _doStart(): Promise<InitializeResult> {
    // Spawn the server process
    const child = spawn(this.options.command, this.options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options.rootPath,
    });
    this.process = child;

    // Handle spawn failures (e.g. command not found, ENOENT).
    // Reject via spawnErrorPromise so start() doesn't hang on sendRequest.
    // Bind to child so stale events from an old spawn don't tear down a newer process.
    const spawnErrorPromise = new Promise<never>((_, reject) => {
      child.on('error', (err) => {
        if (child !== this.process) return; // stale child — ignore
        logWarn('lsp-client', `Failed to spawn ${this.options.command}: ${err.message}`);
        this.cleanup();
        reject(err);
      });
    });

    if (!child.stdout || !child.stdin) {
      // Spawned but streams unavailable — clean up immediately
      this.cleanup();
      throw new Error('Failed to get stdio streams from LSP server process');
    }

    // Capture stderr for diagnostics
    child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        logWarn('lsp-client', `stderr from ${this.options.command}: ${msg.substring(0, 200)}`);
      }
    });

    child.on('exit', (code) => {
      if (child !== this.process) return; // stale child — ignore
      logInfo('lsp-client', `${this.options.command} exited with code ${code}`);
      this.cleanup();
    });

    // Create JSON-RPC connection
    this.connection = createProtocolConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin)
    );
    this.connection.listen();

    // Initialize — clean up resources on any failure
    try {
      const rootUri = pathToFileURL(this.options.rootPath).toString();
      const initParams: InitializeParams = {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            definition: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            hover: {
              dynamicRegistration: false,
              contentFormat: ['plaintext', 'markdown'],
            },
            callHierarchy: { dynamicRegistration: false },
          },
        },
        initializationOptions: this.options.initializationOptions,
      };

      // Race initialization against spawn error to avoid hanging on ENOENT
      const result = await Promise.race([
        this.connection.sendRequest(InitializeRequest.type, initParams),
        spawnErrorPromise,
      ]);

      // Notify initialized
      this.connection.sendNotification('initialized', {});
      this.initialized = true;
      this.resetIdleTimer();

      logInfo('lsp-client', `${this.options.command} initialized for ${this.options.rootPath}`);

      return result;
    } catch (error) {
      // Clean up the spawned process and connection so nothing leaks
      this.cleanup();
      throw error;
    }
  }

  /**
   * Open a text document in the server (or re-sync it if disk content changed).
   *
   * If the document is already open and unchanged, this is a no-op.
   * If the document was opened before but the file has since been modified
   * on disk (detected via mtime tracking in the file watcher), the server
   * receives a DidChange notification with the updated text.
   */
  async openDocument(filePath: string): Promise<void> {
    if (!this.connection) throw new Error('LSP client not started');

    const uri = pathToFileURL(filePath).toString();
    const existingVersion = this.openDocuments.get(uri);

    if (existingVersion === undefined) {
      // First open: read from disk and send DidOpen
      const content = fs.readFileSync(filePath, 'utf-8');
      const languageId = this.detectLanguageId(filePath);

      this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: {
          uri,
          languageId,
          version: 1,
          text: content,
        },
      });
      this.openDocuments.set(uri, 1);

      // Watch for external edits so we can push DidChange on next use
      this.watchFile(filePath, uri);
    }
    // If already open the watcher keeps the version current; nothing to do here.

    this.resetIdleTimer();
  }

  /**
   * Close a text document and stop watching it for changes.
   */
  async closeDocument(filePath: string): Promise<void> {
    if (!this.connection) return;

    const uri = pathToFileURL(filePath).toString();
    if (!this.openDocuments.has(uri)) return;

    this.connection.sendNotification(DidCloseTextDocumentNotification.type, {
      textDocument: { uri },
    });

    this.openDocuments.delete(uri);
    this.unwatchFile(uri);
  }

  // ============================================================================
  // File watching — detect external edits while a document is open
  // ============================================================================

  private watchFile(filePath: string, uri: string): void {
    try {
      const watcher = fs.watch(filePath, { persistent: false }, (event) => {
        if (event === 'change') {
          // Debounce: Windows (and sometimes macOS) fires duplicate 'change' events.
          // Coalesce within 100ms to avoid flooding the LSP server.
          const existing = this.fileChangeTimers.get(uri);
          if (existing) clearTimeout(existing);
          this.fileChangeTimers.set(
            uri,
            setTimeout(() => {
              this.fileChangeTimers.delete(uri);
              this.onFileChanged(filePath, uri);
            }, 100)
          );
        }
      });
      this.fileWatchers.set(uri, watcher);
    } catch (error) {
      // Non-fatal: if we can't watch, the document just won't auto-refresh
      logWarn('lsp-client', `Failed to watch file ${filePath}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private unwatchFile(uri: string): void {
    const timer = this.fileChangeTimers.get(uri);
    if (timer) {
      clearTimeout(timer);
      this.fileChangeTimers.delete(uri);
    }
    const watcher = this.fileWatchers.get(uri);
    if (watcher) {
      watcher.close();
      this.fileWatchers.delete(uri);
    }
  }

  /**
   * Called when a watched file changes on disk.
   * Sends DidChange so the server sees the updated content.
   */
  private onFileChanged(filePath: string, uri: string): void {
    if (!this.connection || !this.openDocuments.has(uri)) return;

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return; // File may have been deleted; don't crash
    }

    const nextVersion = (this.openDocuments.get(uri) ?? 1) + 1;
    this.openDocuments.set(uri, nextVersion);

    this.connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text: content }],
    });
  }

  /**
   * Find the definition of a symbol at a position.
   */
  async definition(filePath: string, line: number, character: number): Promise<LspLocation[]> {
    if (!this.connection) throw new Error('LSP client not started');
    this.resetIdleTimer();

    await this.openDocument(filePath);
    const uri = pathToFileURL(filePath).toString();

    const result = await this.connection.sendRequest(DefinitionRequest.type, {
      textDocument: { uri },
      position: { line, character },
    });

    return this.normalizeLocations(result);
  }

  /**
   * Find all references to a symbol at a position.
   */
  async references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration: boolean = true
  ): Promise<LspLocation[]> {
    if (!this.connection) throw new Error('LSP client not started');
    this.resetIdleTimer();

    await this.openDocument(filePath);
    const uri = pathToFileURL(filePath).toString();

    const result = await this.connection.sendRequest(ReferencesRequest.type, {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration },
    });

    return this.normalizeLocations(result);
  }

  /**
   * Get hover information for a symbol at a position.
   */
  async hover(filePath: string, line: number, character: number): Promise<string | null> {
    if (!this.connection) throw new Error('LSP client not started');
    this.resetIdleTimer();

    await this.openDocument(filePath);
    const uri = pathToFileURL(filePath).toString();

    const result: Hover | null = await this.connection.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position: { line, character },
    });

    if (!result?.contents) return null;

    if (typeof result.contents === 'string') return result.contents;
    if ('value' in result.contents) return result.contents.value;
    if (Array.isArray(result.contents)) {
      return result.contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n');
    }

    return null;
  }

  /**
   * Gracefully shutdown the server.
   */
  async shutdown(): Promise<void> {
    if (!this.connection || !this.initialized) return;

    this.clearIdleTimer();

    try {
      // Close all open documents
      for (const uri of this.openDocuments.keys()) {
        this.connection.sendNotification(DidCloseTextDocumentNotification.type, {
          textDocument: { uri },
        });
      }

      // Send shutdown request
      await this.connection.sendRequest(ShutdownRequest.type);
      // Send exit notification
      this.connection.sendNotification(ExitNotification.type);
    } catch (error) {
      logWarn('lsp-client', 'Error during shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.cleanup();
  }

  /**
   * Check if the client is connected and initialized.
   */
  get isReady(): boolean {
    return this.initialized && this.connection !== null;
  }

  // ============================================================================
  // Internal
  // ============================================================================

  private cleanup(): void {
    this.clearIdleTimer();
    this.initialized = false;

    // Cancel pending file-change debounce timers
    for (const timer of this.fileChangeTimers.values()) {
      clearTimeout(timer);
    }
    this.fileChangeTimers.clear();

    // Stop all file watchers
    for (const watcher of this.fileWatchers.values()) {
      watcher.close();
    }
    this.fileWatchers.clear();

    // Clear document tracking so stale state doesn't persist across restarts
    this.openDocuments.clear();

    if (this.connection) {
      this.connection.dispose();
      this.connection = null;
    }

    if (this.process) {
      if (!this.process.killed) {
        this.process.kill('SIGTERM');
      }
      this.process = null;
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      logInfo('lsp-client', `Idle timeout reached, shutting down ${this.options.command}`);
      this.shutdown().catch((err) => {
        logWarn('lsp-client', 'Shutdown failed on idle timeout', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private normalizeLocations(
    result: Location | Location[] | LocationLink[] | null | undefined
  ): LspLocation[] {
    if (!result) return [];

    const items = Array.isArray(result) ? result : [result];

    // Convert LocationLink to Location format
    const locations: Location[] = items.map((item) => {
      if ('targetUri' in item) {
        // LocationLink
        return { uri: item.targetUri, range: item.targetRange };
      }
      return item as Location;
    });

    return locations.map((loc) => {
      // Use fileURLToPath for correct percent-decoding and platform handling
      const normalizedPath = loc.uri.startsWith('file://')
        ? fileURLToPath(loc.uri)
        : new URL(loc.uri).pathname;

      return {
        uri: loc.uri,
        filePath: normalizedPath,
        line: loc.range.start.line,
        character: loc.range.start.character,
        endLine: loc.range.end.line,
        endCharacter: loc.range.end.character,
      };
    });
  }

  private detectLanguageId(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
      '.py': 'python',
      '.go': 'go',
      '.rs': 'rust',
      '.cs': 'csharp',
      '.c': 'c',
      '.cpp': 'cpp',
      '.h': 'c',
      '.hpp': 'cpp',
      '.rb': 'ruby',
      '.java': 'java',
      '.kt': 'kotlin',
      '.vue': 'vue',
      '.svelte': 'svelte',
    };
    return map[ext] ?? 'plaintext';
  }
}

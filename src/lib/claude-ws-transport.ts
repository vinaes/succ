/**
 * Claude WebSocket Transport
 *
 * Persistent WebSocket connection to Claude Code CLI via the --sdk-url flag.
 * NDJSON protocol over WebSocket — eliminates process-per-call overhead.
 *
 * Protocol based on reverse-engineering by The-Vibe-Company/companion:
 * https://github.com/The-Vibe-Company/companion
 * See their WEBSOCKET_PROTOCOL_REVERSED.md for full protocol spec.
 */

import { WebSocketServer } from 'ws';
import type { WebSocket as WSType } from 'ws';
import spawn from 'cross-spawn';
import { logError, logWarn, logInfo } from './fault-logger.js';
import type { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import type { ChatMessage } from './llm.js';
import { getConfig } from './config.js';
import { ValidationError } from './errors.js';

// ============================================================================
// Types
// ============================================================================

interface PendingRequest {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  responseText: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface WSSendOptions {
  model?: string;
  timeout?: number;
}

// NDJSON message types from Claude CLI
interface NDJSONSystemInit {
  type: 'system';
  subtype: 'init';
  session_id: string;
  tools: string[];
  model: string;
}

interface NDJSONAssistant {
  type: 'assistant';
  message: {
    content: Array<{ type: string; text?: string }>;
  };
}

interface NDJSONResult {
  type: 'result';
  subtype: string;
  is_error: boolean;
  result?: string;
  duration_ms: number;
}

interface NDJSONControlRequest {
  type: 'control_request';
  request_id: string;
  request: {
    subtype: string;
    tool_name?: string;
    input?: Record<string, unknown>;
  };
}

interface NDJSONControlResponse {
  type: 'control_response';
  response: {
    subtype: string;
    request_id: string;
    response?: Record<string, unknown>;
  };
}

interface NDJSONKeepAlive {
  type: 'keep_alive';
}

type NDJSONMessage = NDJSONSystemInit | NDJSONAssistant | NDJSONResult | NDJSONControlRequest | NDJSONControlResponse | NDJSONKeepAlive | { type: string; [key: string]: unknown };

// ============================================================================
// ClaudeWSTransport — Singleton
// ============================================================================

export class ClaudeWSTransport {
  private wss: WebSocketServer | null = null;
  private ws: WSType | null = null;
  private cliProcess: ChildProcess | null = null;
  private sessionId = '';
  private port = 0;
  private pending: PendingRequest | null = null;
  private queue: Array<() => void> = [];
  private processing = false;

  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private readyPromise: Promise<void>;

  // Singleton
  private static instance: ClaudeWSTransport | null = null;
  private static initPromise: Promise<ClaudeWSTransport> | null = null;

  private constructor() {
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  /**
   * Get or create the singleton instance.
   * First call starts WS server + spawns CLI + waits for system/init.
   */
  static async getInstance(): Promise<ClaudeWSTransport> {
    if (ClaudeWSTransport.instance?.ws?.readyState === 1) {
      return ClaudeWSTransport.instance;
    }

    if (ClaudeWSTransport.initPromise) {
      return ClaudeWSTransport.initPromise;
    }

    ClaudeWSTransport.initPromise = (async () => {
      const transport = new ClaudeWSTransport();
      await transport.start();
      ClaudeWSTransport.instance = transport;
      ClaudeWSTransport.initPromise = null;
      return transport;
    })();

    return ClaudeWSTransport.initPromise;
  }

  /**
   * Fire-and-forget warmup — call early so first real call is instant.
   */
  static warmup(): void {
    ClaudeWSTransport.getInstance().catch((err) => {
      logWarn('ws-transport', `Warmup failed: ${err.message}`);
    });
  }

  /**
   * Shutdown: kill CLI process, close WS server, reset singleton.
   */
  static async shutdown(): Promise<void> {
    const inst = ClaudeWSTransport.instance;
    if (!inst) return;
    ClaudeWSTransport.instance = null;
    ClaudeWSTransport.initPromise = null;
    await inst.stop();
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Send a single prompt and get the response text.
   */
  async send(prompt: string, opts?: WSSendOptions): Promise<string> {
    await this.readyPromise;
    return this.enqueue(prompt, opts);
  }

  /**
   * Send multi-turn chat messages (native multi-turn via WS).
   * Sends messages sequentially — each user message waits for its result.
   */
  async sendChat(messages: ChatMessage[], opts?: WSSendOptions): Promise<string> {
    await this.readyPromise;

    // Find system message if any and prepend to first user message
    const systemMsg = messages.find(m => m.role === 'system');
    const userMessages = messages.filter(m => m.role === 'user');

    if (userMessages.length === 0) {
      throw new ValidationError('[claude-ws] No user messages in chat');
    }

    // For multi-turn: send each user message, collect last response
    let lastResponse = '';
    for (let i = 0; i < userMessages.length; i++) {
      let content = userMessages[i].content;
      // Prepend system message to the first user message
      if (i === 0 && systemMsg) {
        content = `System: ${systemMsg.content}\n\n${content}`;
      }
      lastResponse = await this.enqueue(content, opts);
    }

    return lastResponse;
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  private async start(): Promise<void> {
    this.port = await this.startServer();
    this.launchCLI();

    // Wait for CLI to connect and send system/init
    const initTimeout = setTimeout(() => {
      this.readyReject?.(new Error('[claude-ws] CLI did not connect within 30s'));
      this.stop();
    }, 30000);

    await this.readyPromise;
    clearTimeout(initTimeout);

    logInfo('ws-transport', `Ready (port=${this.port}, session=${this.sessionId})`);

    // Cleanup on process exit
    const cleanup = () => { ClaudeWSTransport.shutdown(); };
    process.on('beforeExit', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
  }

  private startServer(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });

      this.wss.on('listening', () => {
        const addr = this.wss!.address();
        if (typeof addr === 'object' && addr) {
          resolve(addr.port);
        } else {
          reject(new Error('[claude-ws] Failed to get server port'));
        }
      });

      this.wss.on('error', (err) => {
        reject(err);
      });

      this.wss.on('connection', (socket) => {
        if (this.ws) {
          logWarn('ws-transport', 'Rejecting second connection');
          socket.close();
          return;
        }
        this.ws = socket;

        // Send initialize handshake after CLI connects (hooks may arrive first, that's fine)
        this.sendInitialize();

        socket.on('message', (data) => {
          const raw = data.toString();
          // NDJSON: multiple JSON objects separated by newlines
          const lines = raw.split('\n').filter(l => l.trim());
          for (const line of lines) {
            try {
              const msg = JSON.parse(line) as NDJSONMessage;
              this.handleMessage(msg);
            } catch {
              logWarn('ws-transport', `Failed to parse NDJSON line: ${line.substring(0, 200)}`);
            }
          }
        });

        socket.on('close', () => {
          logInfo('ws-transport', 'CLI disconnected');
          this.ws = null;
          this.rejectPending(new Error('[claude-ws] CLI disconnected'));
          // Reset singleton so next call restarts
          ClaudeWSTransport.instance = null;
          ClaudeWSTransport.initPromise = null;
        });

        socket.on('error', (err) => {
          logError('ws-transport', `Socket error: ${err.message}`, err instanceof Error ? err : new Error(String(err)));
        });
      });
    });
  }

  private launchCLI(): void {
    const sdkUrl = `ws://127.0.0.1:${this.port}`;

    const args = [
      '--sdk-url', sdkUrl,
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--no-session-persistence',
      '-p', '',
    ];

    // WS mode always uses Claude API — resolve model from config.
    // Priority: llm.claude.model → llm.model → 'haiku'
    const config = getConfig();
    const llm = config.llm || {};
    const model = llm.claude?.model || llm.model || 'haiku';
    args.push('--model', model);

    this.cliProcess = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SUCC_SERVICE_SESSION: '1' },
      windowsHide: true,
    });

    // Log stderr for debugging
    this.cliProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        logInfo('ws-transport', `CLI stderr: ${text}`);
      }
    });

    // stdout in sdk-url mode should be empty, but log just in case
    this.cliProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        logInfo('ws-transport', `CLI stdout: ${text}`);
      }
    });

    this.cliProcess.on('close', (code) => {
      logInfo('ws-transport', `CLI process exited (code=${code})`);
      this.cliProcess = null;
      this.rejectPending(new Error(`[claude-ws] CLI exited with code ${code}`));
    });

    this.cliProcess.on('error', (err) => {
      logError('ws-transport', `CLI spawn error: ${err.message}`, err);
      this.cliProcess = null;
      this.readyReject?.(err);
      this.rejectPending(err);
    });
  }

  private async stop(): Promise<void> {
    this.rejectPending(new Error('[claude-ws] Shutting down'));

    if (this.cliProcess) {
      this.cliProcess.kill('SIGTERM');
      this.cliProcess = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }
  }

  // ============================================================================
  // Message handling
  // ============================================================================

  private initRequestId = '';

  /**
   * Send initialize control_request to CLI.
   * Required by the SDK protocol before sending any user messages.
   */
  private sendInitialize(): void {
    if (!this.ws || this.ws.readyState !== 1) return;

    this.initRequestId = randomUUID();
    const initReq = JSON.stringify({
      type: 'control_request',
      request_id: this.initRequestId,
      request: {
        subtype: 'initialize',
      },
    });
    this.ws.send(initReq + '\n');
  }

  private handleMessage(msg: NDJSONMessage): void {
    switch (msg.type) {
      case 'system':
        if ((msg as NDJSONSystemInit).subtype === 'init') {
          // system/init arrives after first user message — just save session_id
          const initMsg = msg as NDJSONSystemInit;
          this.sessionId = initMsg.session_id;
        }
        // hook_response etc. — ignore
        break;

      case 'control_response': {
        const ctrlResp = msg as NDJSONControlResponse;
        if (ctrlResp.response.request_id === this.initRequestId) {
          // Initialize handshake complete — transport is ready
          this.readyResolve?.();
          this.readyResolve = null;
          this.readyReject = null;
        }
        break;
      }

      case 'assistant':
        if (this.pending) {
          const assistantMsg = msg as NDJSONAssistant;
          // Collect text from content blocks
          for (const block of assistantMsg.message.content) {
            if (block.type === 'text' && block.text) {
              this.pending.responseText += block.text;
            }
          }
        }
        break;

      case 'result': {
        const resultMsg = msg as NDJSONResult;
        if (this.pending) {
          clearTimeout(this.pending.timer);
          if (resultMsg.is_error || resultMsg.subtype.startsWith('error')) {
            this.pending.reject(new Error(
              `[claude-ws] CLI error: ${resultMsg.subtype} — ${resultMsg.result || 'unknown'}`
            ));
          } else {
            // Use collected assistant text, fall back to result text
            const text = this.pending.responseText.trim() || resultMsg.result?.trim() || '';
            this.pending.resolve(text);
          }
          this.pending = null;
          this.processing = false;
          this.processNext();
        }
        break;
      }

      case 'control_request': {
        const ctrlMsg = msg as NDJSONControlRequest;
        if (ctrlMsg.request.subtype === 'can_use_tool') {
          this.autoApproveTool(ctrlMsg);
        }
        break;
      }

      case 'keep_alive':
        // Ignore heartbeat
        break;

      default:
        // stream_event, tool_progress, etc. — ignore
        break;
    }
  }

  private autoApproveTool(msg: NDJSONControlRequest): void {
    if (!this.ws) return;

    const response = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: msg.request_id,
        response: {
          behavior: 'allow',
          updatedInput: msg.request.input || {},
        },
      },
    });

    this.ws.send(response + '\n');
  }

  // ============================================================================
  // Request queue (serial — one prompt at a time)
  // ============================================================================

  private enqueue(prompt: string, opts?: WSSendOptions): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const work = () => {
        this.processing = true;
        this.sendPrompt(prompt, opts, resolve, reject);
      };

      if (!this.processing) {
        work();
      } else {
        this.queue.push(work);
      }
    });
  }

  private processNext(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }

  private sendPrompt(
    prompt: string,
    opts: WSSendOptions | undefined,
    resolve: (text: string) => void,
    reject: (err: Error) => void,
  ): void {
    if (!this.ws || this.ws.readyState !== 1) {
      reject(new Error('[claude-ws] Not connected'));
      this.processing = false;
      this.processNext();
      return;
    }

    const timeout = opts?.timeout ?? 60000;

    const timer = setTimeout(() => {
      if (this.pending) {
        this.pending.reject(new Error(`[claude-ws] Request timed out after ${timeout}ms`));
        this.pending = null;
        this.processing = false;
        // Kill CLI on timeout — stale state
        this.stop();
        ClaudeWSTransport.instance = null;
        ClaudeWSTransport.initPromise = null;
        this.processNext();
      }
    }, timeout);

    this.pending = { resolve, reject, responseText: '', timer };

    const message = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    });

    this.ws.send(message + '\n');
  }

  private rejectPending(err: Error): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(err);
      this.pending = null;
    }
    // Reject all queued
    this.queue.splice(0);
    this.queue = [];
    this.processing = false;
  }
}

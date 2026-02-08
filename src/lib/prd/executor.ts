/**
 * Agent Executor
 *
 * Thin abstraction over child_process.spawn for running Claude Code CLI.
 * Uses `-p --no-session-persistence` with SUCC_SERVICE_SESSION env marker,
 * matching the canonical pattern from llm.ts (buildClaudeArgs / CLAUDE_SPAWN_OPTIONS).
 * Prompt is piped via stdin to avoid shell escaping issues.
 */

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';

// ============================================================================
// Types
// ============================================================================

export interface ExecuteOptions {
  cwd: string;
  timeout_ms: number;
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
  allowedTools?: string[];
  mcpConfig?: Record<string, { command: string; args?: string[] }>;
  onOutput?: (chunk: string) => void;
}

export interface ExecuteResult {
  success: boolean;
  output: string;
  duration_ms: number;
  exit_code: number;
}

export interface AgentExecutor {
  execute(prompt: string, options: ExecuteOptions): Promise<ExecuteResult>;
  abort(): void;
}

// ============================================================================
// Loop Executor (claude --print)
// ============================================================================

/**
 * Executes tasks via `claude --print` — one-shot CLI invocation.
 * Prompt is piped via stdin. Stdout is captured as the result.
 */
export class LoopExecutor implements AgentExecutor {
  private process: ChildProcess | null = null;
  private aborted = false;

  async execute(prompt: string, options: ExecuteOptions): Promise<ExecuteResult> {
    this.aborted = false;
    const start = Date.now();

    // Build args matching llm.ts pattern: -p, --no-session-persistence
    const args = ['-p', '--no-session-persistence'];

    if (options.model) {
      args.push('--model', options.model);
    }

    if (options.permissionMode && options.permissionMode !== 'default') {
      args.push('--permission-mode', options.permissionMode);
    }

    if (options.allowedTools && options.allowedTools.length > 0) {
      args.push('--allowedTools', options.allowedTools.join(','));
    }

    // Pass MCP server config so spawned claude can access succ tools
    if (options.mcpConfig && Object.keys(options.mcpConfig).length > 0) {
      const mcpJson = JSON.stringify({ mcpServers: options.mcpConfig });
      args.push('--mcp-config', mcpJson);
    }

    return new Promise<ExecuteResult>((resolve) => {
      const chunks: string[] = [];
      let resolved = false;

      const finish = (exit_code: number) => {
        if (resolved) return;
        resolved = true;
        this.process = null;

        resolve({
          success: exit_code === 0 && !this.aborted,
          output: chunks.join(''),
          duration_ms: Date.now() - start,
          exit_code,
        });
      };

      try {
        this.process = spawn('claude', args, {
          cwd: options.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, SUCC_SERVICE_SESSION: '1' },
          windowsHide: true,
        });

        // Write prompt to stdin and close it
        if (this.process.stdin) {
          this.process.stdin.write(prompt);
          this.process.stdin.end();
        }

        // Timeout handling
        const timer = setTimeout(() => {
          if (!resolved && this.process) {
            this.process.kill('SIGTERM');
            chunks.push('\n[TIMEOUT] Task exceeded time limit\n');
            finish(124); // Standard timeout exit code
          }
        }, options.timeout_ms);

        this.process.stdout?.on('data', (data: Buffer) => {
          const text = data.toString();
          chunks.push(text);
          options.onOutput?.(text);
        });

        this.process.stderr?.on('data', (data: Buffer) => {
          const text = data.toString();
          chunks.push(text);
          options.onOutput?.(text);
        });

        this.process.on('close', (code) => {
          clearTimeout(timer);
          finish(code ?? 1);
        });

        this.process.on('error', (err) => {
          clearTimeout(timer);
          chunks.push(`\n[ERROR] ${err.message}\n`);
          finish(1);
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        chunks.push(`\n[SPAWN ERROR] ${msg}\n`);
        finish(1);
      }
    });
  }

  abort(): void {
    this.aborted = true;
    if (this.process) {
      this.process.kill('SIGTERM');
    }
  }
}

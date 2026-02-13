/**
 * MCP Debug Session tools
 *
 * succ_debug: Language-independent structured debugging with hypothesis testing.
 * Manages debug sessions in .succ/debugs/ with dead_end integration.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isGlobalOnlyMode } from '../../lib/config.js';
import { projectPathParam, applyProjectPath } from '../helpers.js';
import {
  generateSessionId,
  ensureDebugsDir,
  saveSession,
  loadSession,
  listSessions,
  findActiveSession,
  appendSessionLog,
  loadSessionLog,
} from '../../lib/debug/state.js';
import { detectLanguage, generateLogStatement } from '../../lib/debug/types.js';
import type { DebugSession, Hypothesis, DebugLanguage } from '../../lib/debug/types.js';

function requireProject(): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} | null {
  if (isGlobalOnlyMode()) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Debug sessions require a project with .succ/ initialized. Run `succ init` first.',
        },
      ],
      isError: true,
    };
  }
  return null;
}

export function registerDebugTools(server: McpServer) {
  // =========================================================================
  // succ_debug — main debug session management tool
  // =========================================================================
  server.tool(
    'succ_debug',
    'Language-independent structured debugging. Create sessions, add hypotheses, track instrumented files, record results. Integrates with succ_dead_end for failed hypotheses.',
    {
      action: z
        .enum([
          'create', // Start a new debug session
          'hypothesis', // Add a hypothesis to the active session
          'instrument', // Record instrumented files/lines
          'result', // Record hypothesis result (confirmed/refuted)
          'resolve', // Mark session as resolved with root cause + fix
          'abandon', // Abandon session
          'status', // Show active session status
          'list', // List all sessions
          'log', // Append to session log
          'show_log', // Show session log
          'detect_lang', // Detect language from file path
          'gen_log', // Generate log statement for a language
        ])
        .describe('Action to perform'),
      // Session creation params
      bug_description: z.string().optional().describe('Bug description (for create)'),
      error_output: z.string().optional().describe('Error output or stack trace (for create)'),
      reproduction_command: z
        .string()
        .optional()
        .describe('Command to reproduce the bug (for create)'),
      language: z.string().optional().describe('Override language detection (for create)'),
      // Hypothesis params
      description: z.string().optional().describe('Hypothesis description (for hypothesis)'),
      confidence: z
        .enum(['high', 'medium', 'low'])
        .optional()
        .describe('Confidence level (for hypothesis)'),
      evidence: z.string().optional().describe('Evidence supporting hypothesis (for hypothesis)'),
      test: z.string().optional().describe('How to test this hypothesis (for hypothesis)'),
      // Instrument params
      file_path: z
        .string()
        .optional()
        .describe('Instrumented file path (for instrument, detect_lang)'),
      lines: z
        .array(z.number())
        .optional()
        .describe('Line numbers of added instrumentation (for instrument)'),
      // Result params
      hypothesis_id: z.number().optional().describe('Hypothesis ID (1-based) (for result)'),
      confirmed: z.boolean().optional().describe('Whether hypothesis was confirmed (for result)'),
      logs: z.string().optional().describe('Log output from reproduction (for result)'),
      // Resolve params
      root_cause: z.string().optional().describe('Root cause description (for resolve)'),
      fix_description: z.string().optional().describe('Fix description (for resolve)'),
      files_modified: z
        .array(z.string())
        .optional()
        .describe('Files modified to fix (for resolve)'),
      // Session selector
      session_id: z.string().optional().describe('Session ID (defaults to active session)'),
      // List params
      include_resolved: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include resolved sessions in list'),
      // Log params
      entry: z.string().optional().describe('Log entry text (for log)'),
      // gen_log params
      tag: z.string().optional().describe('Log tag (for gen_log)'),
      value: z.string().optional().describe('Value to log (for gen_log)'),
      project_path: projectPathParam,
    },
    async (params) => {
      await applyProjectPath(params.project_path);
      const err = requireProject();
      if (err) return err;

      try {
        const { action } = params;

        switch (action) {
          case 'create': {
            if (!params.bug_description) {
              return {
                content: [
                  { type: 'text' as const, text: 'bug_description is required for create' },
                ],
                isError: true,
              };
            }
            ensureDebugsDir();
            const id = generateSessionId();
            const lang: DebugLanguage = (params.language as DebugLanguage) ?? 'unknown';
            const session: DebugSession = {
              id,
              status: 'active',
              bug_description: params.bug_description,
              error_output: params.error_output,
              reproduction_command: params.reproduction_command,
              language: lang,
              hypotheses: [],
              instrumented_files: [],
              iteration: 0,
              max_iterations: 5,
              files_modified: [],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            saveSession(session);
            appendSessionLog(id, `Session created: ${params.bug_description.substring(0, 100)}`);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Debug session created: ${id}\nBug: ${params.bug_description}\nLanguage: ${lang}\nReproduction: ${params.reproduction_command ?? '(not set)'}`,
                },
              ],
            };
          }

          case 'hypothesis': {
            const session = getSession(params.session_id);
            if (!session) return noSession();
            if (!params.description) {
              return {
                content: [
                  { type: 'text' as const, text: 'description is required for hypothesis' },
                ],
                isError: true,
              };
            }
            const h: Hypothesis = {
              id: session.hypotheses.length + 1,
              description: params.description,
              confidence: params.confidence ?? 'medium',
              evidence: params.evidence ?? '',
              test: params.test ?? '',
              result: 'pending',
            };
            session.hypotheses.push(h);
            saveSession(session);
            appendSessionLog(session.id, `Hypothesis #${h.id} (${h.confidence}): ${h.description}`);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Hypothesis #${h.id} added (${h.confidence}):\n  ${h.description}\n  Evidence: ${h.evidence}\n  Test: ${h.test}`,
                },
              ],
            };
          }

          case 'instrument': {
            const session = getSession(params.session_id);
            if (!session) return noSession();
            if (!params.file_path) {
              return {
                content: [{ type: 'text' as const, text: 'file_path is required for instrument' }],
                isError: true,
              };
            }
            const existing = session.instrumented_files.find((f) => f.path === params.file_path);
            if (existing) {
              existing.lines = [...new Set([...existing.lines, ...(params.lines ?? [])])];
            } else {
              session.instrumented_files.push({
                path: params.file_path,
                lines: params.lines ?? [],
              });
            }
            saveSession(session);
            appendSessionLog(
              session.id,
              `Instrumented: ${params.file_path} lines=${(params.lines ?? []).join(',')}`
            );
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Instrumented ${params.file_path} at lines [${(params.lines ?? []).join(', ')}]\nTotal instrumented files: ${session.instrumented_files.length}`,
                },
              ],
            };
          }

          case 'result': {
            const session = getSession(params.session_id);
            if (!session) return noSession();
            if (params.hypothesis_id == null) {
              return {
                content: [{ type: 'text' as const, text: 'hypothesis_id is required for result' }],
                isError: true,
              };
            }
            const h = session.hypotheses.find((x) => x.id === params.hypothesis_id);
            if (!h) {
              return {
                content: [
                  { type: 'text' as const, text: `Hypothesis #${params.hypothesis_id} not found` },
                ],
                isError: true,
              };
            }
            h.result = params.confirmed ? 'confirmed' : 'refuted';
            h.logs = params.logs;
            session.iteration++;
            saveSession(session);
            const status = params.confirmed ? 'CONFIRMED' : 'REFUTED';
            appendSessionLog(session.id, `Hypothesis #${h.id} ${status}: ${h.description}`);
            let text = `Hypothesis #${h.id} ${status}: ${h.description}`;
            if (!params.confirmed) {
              text += `\n\nConsider recording as dead_end:\n  succ_dead_end(approach="${h.description}", why_failed="<reason>", tags=["debug"])`;
            }
            return { content: [{ type: 'text' as const, text }] };
          }

          case 'resolve': {
            const session = getSession(params.session_id);
            if (!session) return noSession();
            session.status = 'resolved';
            session.root_cause = params.root_cause;
            session.fix_description = params.fix_description;
            session.files_modified = params.files_modified ?? [];
            session.resolved_at = new Date().toISOString();
            saveSession(session);
            appendSessionLog(session.id, `RESOLVED: ${params.root_cause ?? 'unknown'}`);
            const confirmed = session.hypotheses.filter((h) => h.result === 'confirmed').length;
            const refuted = session.hypotheses.filter((h) => h.result === 'refuted').length;
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Debug session ${session.id} resolved.\nRoot cause: ${params.root_cause ?? 'not specified'}\nFix: ${params.fix_description ?? 'not specified'}\nFiles: ${(params.files_modified ?? []).join(', ') || 'none'}\nHypotheses: ${confirmed} confirmed, ${refuted} refuted, ${session.hypotheses.length} total\nIterations: ${session.iteration}`,
                },
              ],
            };
          }

          case 'abandon': {
            const session = getSession(params.session_id);
            if (!session) return noSession();
            session.status = 'abandoned';
            saveSession(session);
            appendSessionLog(session.id, 'Session abandoned');
            return {
              content: [{ type: 'text' as const, text: `Session ${session.id} abandoned.` }],
            };
          }

          case 'status': {
            const session = params.session_id
              ? loadSession(params.session_id)
              : (() => {
                  const active = findActiveSession();
                  return active ? loadSession(active.id) : null;
                })();
            if (!session) return noSession();
            const lines = [
              `Session: ${session.id} (${session.status})`,
              `Bug: ${session.bug_description}`,
              `Language: ${session.language}`,
              `Iteration: ${session.iteration}/${session.max_iterations}`,
              `Hypotheses: ${session.hypotheses.length}`,
            ];
            for (const h of session.hypotheses) {
              lines.push(
                `  #${h.id} [${h.result.toUpperCase()}] (${h.confidence}) ${h.description}`
              );
            }
            if (session.instrumented_files.length > 0) {
              lines.push(`Instrumented files: ${session.instrumented_files.length}`);
              for (const f of session.instrumented_files) {
                lines.push(`  ${f.path} lines=[${f.lines.join(',')}]`);
              }
            }
            if (session.root_cause) lines.push(`Root cause: ${session.root_cause}`);
            if (session.fix_description) lines.push(`Fix: ${session.fix_description}`);
            return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
          }

          case 'list': {
            const sessions = listSessions(params.include_resolved);
            if (sessions.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: params.include_resolved
                      ? 'No debug sessions found.'
                      : 'No active debug sessions. Use action="list" include_resolved=true to see all.',
                  },
                ],
              };
            }
            const lines = sessions.map(
              (s) =>
                `${s.id} [${s.status}] ${s.language} iter=${s.iteration} hypotheses=${s.hypothesis_count} — ${s.bug_description}`
            );
            return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
          }

          case 'log': {
            const session = getSession(params.session_id);
            if (!session) return noSession();
            if (!params.entry) {
              return {
                content: [{ type: 'text' as const, text: 'entry is required for log' }],
                isError: true,
              };
            }
            appendSessionLog(session.id, params.entry);
            return {
              content: [{ type: 'text' as const, text: `Log appended to session ${session.id}` }],
            };
          }

          case 'show_log': {
            const session = getSession(params.session_id);
            if (!session) return noSession();
            const log = loadSessionLog(session.id);
            return { content: [{ type: 'text' as const, text: log || '(empty log)' }] };
          }

          case 'detect_lang': {
            if (!params.file_path) {
              return {
                content: [{ type: 'text' as const, text: 'file_path is required for detect_lang' }],
                isError: true,
              };
            }
            const lang = detectLanguage(params.file_path);
            return { content: [{ type: 'text' as const, text: `${params.file_path} → ${lang}` }] };
          }

          case 'gen_log': {
            const lang: DebugLanguage = (params.language as DebugLanguage) ?? 'unknown';
            const stmt = generateLogStatement(lang, params.tag ?? 'debug', params.value ?? 'value');
            return { content: [{ type: 'text' as const, text: stmt }] };
          }

          default:
            return {
              content: [{ type: 'text' as const, text: `Unknown action: ${action}` }],
              isError: true,
            };
        }
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Debug tool error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}

// ============================================================================
// Helpers
// ============================================================================

function getSession(sessionId?: string): DebugSession | null {
  if (sessionId) return loadSession(sessionId);
  const active = findActiveSession();
  return active ? loadSession(active.id) : null;
}

function noSession() {
  return {
    content: [
      { type: 'text' as const, text: 'No active debug session. Use action="create" to start one.' },
    ],
    isError: true,
  };
}

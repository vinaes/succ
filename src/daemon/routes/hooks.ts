/**
 * HTTP Hook Routes — handle Claude Code hook events directly via HTTP POST.
 *
 * Replaces the .cjs command hooks when Claude Code v2.1.63+ is detected.
 * All routes are fail-open: return 200 {} on errors so hooks never block Claude.
 */

import path from 'path';
import fs from 'fs';
import { z } from 'zod';

import { getMemoriesByTag, saveMemory } from '../../lib/storage/index.js';
import { getEmbedding } from '../../lib/embeddings.js';
import { matchRules } from '../../lib/hook-rules.js';
import { checkDangerous, extractSafetyConfig } from '../../lib/command-safety.js';
import { removeObservations } from '../../lib/session-observations.js';
import { flushBudgets, removeBudget } from '../../lib/token-budget.js';
import { getConfig } from '../../lib/config.js';
import { spawnClaudeCLI } from '../../lib/llm.js';
import { logWarn } from '../../lib/fault-logger.js';
import type { Memory } from '../../lib/storage/types.js';
import { parseRequestBody, type RouteContext, type RouteMap } from './types.js';

// ─── Schemas ─────────────────────────────────────────────────────────

const HookBaseSchema = z
  .object({
    hookEventName: z.string().optional(),
    session_id: z.string().optional(),
    cwd: z.string().optional(),
    transcript_path: z.string().optional(),
  })
  .passthrough();

const PreToolSchema = HookBaseSchema.extend({
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
});

const PostToolSchema = HookBaseSchema.extend({
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_output: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  tool_error: z.unknown().optional(),
});

const PermissionSchema = HookBaseSchema.extend({
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
});

const SubagentStopSchema = HookBaseSchema.extend({
  agent_type: z.string().optional(),
  tool_output: z.string().optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────

const HOOK_RULES_CACHE_TTL = 60_000;
let hookRulesCache: { memories: Memory[]; timestamp: number } | null = null;

async function getHookRuleMemories(): Promise<Memory[]> {
  const now = Date.now();
  if (hookRulesCache && now - hookRulesCache.timestamp <= HOOK_RULES_CACHE_TTL) {
    return hookRulesCache.memories;
  }
  const memories = await getMemoriesByTag('hook-rule', 50);
  hookRulesCache = { memories, timestamp: now };
  return memories;
}

/**
 * Parse MEMORY.md bullets, classify by section header.
 * Returns [{ text, tags }] for each bullet worth saving.
 */
function parseMemoryMdBullets(content: string): { text: string; tags: string[] }[] {
  const results: { text: string; tags: string[] }[] = [];
  let currentSection = '';

  for (const line of content.split('\n')) {
    const headerMatch = line.match(/^##\s+(.+)/);
    if (headerMatch) {
      currentSection = headerMatch[1].trim().toLowerCase();
      continue;
    }

    const bulletMatch = line.match(/^-\s+(.+)/);
    if (!bulletMatch) continue;

    const text = bulletMatch[1].trim();
    if (text.length < 10) continue;

    const tags = ['memory-md'];
    if (/gotcha/i.test(currentSection)) tags.push('gotcha');
    else if (/learning|lesson/i.test(currentSection)) tags.push('learning');
    else if (/decision|chose/i.test(currentSection)) tags.push('decision');
    else if (/pattern/i.test(currentSection)) tags.push('pattern');
    else if (/change|phase/i.test(currentSection)) tags.push('changelog');
    else tags.push('observation');

    results.push({ text, tags });
  }

  return results;
}

function fixWindowsPath(cwd: string): string {
  if (process.platform === 'win32' && /^\/[a-z]\//.test(cwd)) {
    return cwd[1].toUpperCase() + ':' + cwd.slice(2);
  }
  return cwd;
}

function succExists(cwd: string): boolean {
  try {
    return fs.existsSync(path.join(cwd, '.succ'));
  } catch {
    return false;
  }
}

function buildCommitContext(): string {
  const config = getConfig();
  const parts: string[] = [];

  if (config.includeCoAuthoredBy !== false) {
    parts.push(`<commit-format>
Footer order (succ always LAST):
1. Generated with [Claude Code]
2. via [Happy] (if used)
3. powered by [succ](https://succ.ai)

Co-Authored-By order (succ always LAST):
1. Co-Authored-By: Claude <noreply@anthropic.com>
2. Co-Authored-By: Happy <yesreply@happy.engineering> (if used)
3. Co-Authored-By: succ <mindpalace@succ.ai>
</commit-format>`);
  }

  if (config.preCommitReview) {
    parts.push(`<pre-commit-review>
STOP. Before committing, you MUST run the succ-diff-reviewer agent first.
Use: Task tool with subagent_type="succ-diff-reviewer"
Prompt: "Review the staged git diff for bugs, security issues, and regressions before commit"

If diff-reviewer finds CRITICAL issues — do NOT commit until fixed.
If diff-reviewer finds HIGH issues — warn the user before committing.
MEDIUM and below — commit is OK, mention findings in summary.
</pre-commit-review>`);
  }

  return parts.join('\n');
}

// ─── Routes ──────────────────────────────────────────────────────────

export function hookRoutes(ctx: RouteContext): RouteMap {
  return {
    // ═══════════════════════════════════════════════════════════════
    // PreToolUse — hook-rules + file-linked memories + safety guard
    // ═══════════════════════════════════════════════════════════════
    'POST /api/hooks/pre-tool': async (body) => {
      try {
        const input = parseRequestBody(PreToolSchema, body);
        const cwd = fixWindowsPath(input.cwd || '');
        if (!cwd || !succExists(cwd)) return {};

        const toolName = input.tool_name || '';
        const toolInput =
          input.tool_input && typeof input.tool_input === 'object'
            ? (input.tool_input as Record<string, unknown>)
            : {};
        const filePath = (toolInput.file_path as string) || '';
        const command = (toolInput.command as string) || '';
        const contextParts: string[] = [];
        let askReason: string | null = null;

        // 1. Dynamic hook rules
        const memories = await getHookRuleMemories();
        const rules = matchRules(memories, toolName, toolInput);
        for (const rule of rules) {
          if (rule.action === 'deny') {
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: `[succ rule] ${rule.content}`,
              },
            };
          }
          if (rule.action === 'ask' && !askReason) {
            askReason = rule.content;
          }
          if (rule.action === 'inject' || rule.action === 'allow') {
            contextParts.push(`<hook-rule>${rule.content}</hook-rule>`);
          }
        }

        // 2. File-linked memories (Edit/Write only)
        if ((toolName === 'Edit' || toolName === 'Write') && filePath) {
          try {
            const fileName = path.basename(filePath);
            const fileMemories = await getMemoriesByTag(`file:${fileName}`, 5);
            if (fileMemories.length > 0) {
              const lines = fileMemories.map(
                (m) => `- [${m.type || 'observation'}] ${m.content.slice(0, 200)}`
              );
              contextParts.push(
                `<file-context file="${fileName}">\nRelated memories:\n${lines.join('\n')}\n</file-context>`
              );
            }
          } catch {
            // fail-open
          }
        }

        // 3. Command safety guard (Bash only)
        if (command) {
          const config = getConfig();
          const safetyConfig = extractSafetyConfig(config.commandSafetyGuard);
          const dangerResult = checkDangerous(command, safetyConfig);
          if (dangerResult) {
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: dangerResult.mode === 'ask' ? 'ask' : 'deny',
                permissionDecisionReason: `[succ guard] ${dangerResult.reason}`,
              },
            };
          }

          // 4. Hook rule ask (after safety guard)
          if (askReason) {
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'ask',
                permissionDecisionReason: `[succ rule] ${askReason}`,
              },
            };
          }

          // 5. Git commit guidelines
          if (/\bgit\s+commit\b/.test(command)) {
            const commitContext = buildCommitContext();
            if (commitContext) contextParts.push(commitContext);
          }
        } else if (askReason) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'ask',
              permissionDecisionReason: `[succ rule] ${askReason}`,
            },
          };
        }

        // 6. Emit combined context
        if (contextParts.length > 0) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: contextParts.join('\n'),
            },
          };
        }

        return {};
      } catch {
        return {}; // fail-open
      }
    },

    // ═══════════════════════════════════════════════════════════════
    // PostToolUse — auto-capture (git, deps, tests, files, MEMORY.md sync, subagents)
    // ═══════════════════════════════════════════════════════════════
    'POST /api/hooks/post-tool': async (body) => {
      try {
        const input = parseRequestBody(PostToolSchema, body);
        const cwd = fixWindowsPath(input.cwd || '');
        if (!cwd || !succExists(cwd)) return {};
        if (input.tool_error) return {}; // skip failed tool calls

        const toolName = input.tool_name || '';
        const toolInput = (input.tool_input as Record<string, unknown>) || {};
        // Keep raw value for Task subagent parsing (may be object), stringify for text matching
        const rawToolOutput = input.tool_output ?? input.tool_response ?? '';
        const toolOutput = typeof rawToolOutput === 'string' ? rawToolOutput : '';

        const remember = async (content: string, tags: string[]) => {
          try {
            const embedding = await getEmbedding(content);
            await saveMemory(content, embedding, [...tags, 'auto-capture'], 'auto-capture', {
              type: 'observation',
            });
          } catch {
            // fail-open
          }
        };

        // 1. Git commits
        if (toolName === 'Bash' && toolInput.command) {
          const cmd = toolInput.command as string;

          if (/\bgit\s+commit\b/i.test(cmd)) {
            // Try to extract from git output first, fallback to -m flag
            const outputMatch = toolOutput.match(/\[[\w/.-]+\s+([a-f0-9]+)]\s+(.+)/);
            if (outputMatch) {
              await remember(`Committed: ${outputMatch[2]} (${outputMatch[1]})`, [
                'git',
                'commit',
                'milestone',
              ]);
            } else {
              const msgMatch = cmd.match(/-m\s+["']([^"']+)["']/);
              if (msgMatch) {
                await remember(`Committed: ${msgMatch[1]}`, ['git', 'commit', 'milestone']);
              }
            }
          }

          // 2. Dependency install (skip flags like -D, --save-dev)
          const installMatch = cmd.match(
            /(?:npm|yarn|pnpm)\s+(?:install|add)\s+(.+?)(?:\s*[;&|]|$)/i
          );
          if (installMatch) {
            const tokens = installMatch[1].split(/\s+/).filter((t) => !t.startsWith('-'));
            const pkgName = tokens[0];
            if (pkgName) {
              await remember(`Added dependency: ${pkgName}`, ['dependency', 'package']);
            }
          }

          // 3. Test run detection
          if (/(?:npm\s+test|yarn\s+test|pytest|jest|vitest)/i.test(cmd)) {
            const passed = /pass|success|ok|✓/i.test(toolOutput);
            const failed = /fail|error|✗|✘/i.test(toolOutput);
            if (passed && !failed) {
              await remember('Tests passed after changes', ['test', 'success']);
            }
          }
        }

        // 4. File creation
        if (toolName === 'Write' && toolInput.file_path) {
          const filePath = toolInput.file_path as string;
          const relativePath = path.relative(cwd, filePath);
          if (
            !relativePath.includes('node_modules') &&
            !relativePath.includes('.tmp') &&
            !relativePath.startsWith('.') &&
            /\.(ts|tsx|js|jsx|py|go|rs|md)$/.test(relativePath)
          ) {
            const content = (toolInput.content as string) || '';
            if (content.length < 5000) {
              await remember(`Created file: ${relativePath}`, ['file', 'created']);
            }
          }
        }

        // 5. Task/subagent results → save findings to long-term memory
        if (toolName === 'Task' && toolInput.subagent_type) {
          const agentType = toolInput.subagent_type as string;
          if (/^(Explore|Plan|feature-dev|succ-)/.test(agentType)) {
            let text = '';
            try {
              const parsed =
                typeof rawToolOutput === 'string' ? JSON.parse(rawToolOutput) : rawToolOutput;
              if (parsed && typeof parsed === 'object' && Array.isArray(parsed.content)) {
                text = parsed.content
                  .filter((c: { type?: string; text?: string }) => c.type === 'text' && c.text)
                  .map((c: { text: string }) => c.text)
                  .join('\n\n');
              } else if (typeof parsed === 'string') {
                text = parsed;
              }
            } catch {
              text = typeof rawToolOutput === 'string' ? rawToolOutput : '';
            }

            if (text.length > 50 && text.length < 20000) {
              const agentAlreadySaved =
                /^succ-/.test(agentType) &&
                /succ_remember|saved to memory|memory \(id:/i.test(text);
              if (!agentAlreadySaved) {
                const desc = ((toolInput.description as string) || '').slice(0, 100);
                const content = `[${agentType}] ${desc}\n\n${text.slice(0, 3000)}`;
                await remember(content, ['subagent', agentType.toLowerCase()]);
              }
            }
          }
        }

        // 6. MEMORY.md sync — parse bullets, save each to long-term memory
        if ((toolName === 'Edit' || toolName === 'Write') && toolInput.file_path) {
          const filePath = toolInput.file_path as string;
          if (path.basename(filePath) === 'MEMORY.md') {
            try {
              const memContent = fs.readFileSync(filePath, 'utf8');
              const bullets = parseMemoryMdBullets(memContent);
              await Promise.allSettled(
                bullets.map(async (bullet) => {
                  try {
                    const embedding = await getEmbedding(bullet.text);
                    await saveMemory(bullet.text, embedding, bullet.tags, 'memory-md-sync', {
                      type: 'observation',
                    });
                  } catch {
                    // fail-open per bullet
                  }
                })
              );
            } catch {
              // fail-open — file may not exist
            }
          }
        }

        return {};
      } catch {
        return {};
      }
    },

    // ═══════════════════════════════════════════════════════════════
    // UserPromptSubmit — compact fallback + activity + skill suggestions
    // ═══════════════════════════════════════════════════════════════
    'POST /api/hooks/user-prompt': async (body) => {
      try {
        const input = parseRequestBody(HookBaseSchema, body);
        const cwd = fixWindowsPath(input.cwd || '');
        if (!cwd || !succExists(cwd)) return {};

        const sessionId = input.session_id;
        const tmpDir = path.join(cwd, '.succ', '.tmp');

        // Track user activity
        if (sessionId && ctx.sessionManager) {
          try {
            ctx.sessionManager.activity(sessionId, 'user_prompt');
          } catch {
            // session not registered
          }
        }

        // Compact-pending fallback
        const compactPendingFile = path.join(tmpDir, 'compact-pending');
        if (fs.existsSync(compactPendingFile)) {
          try {
            const pendingContext = fs.readFileSync(compactPendingFile, 'utf8');
            fs.unlinkSync(compactPendingFile);

            if (pendingContext.trim()) {
              return {
                hookSpecificOutput: {
                  hookEventName: 'UserPromptSubmit',
                  additionalContext: `<compact-fallback reason="SessionStart output may have been lost">\n${pendingContext}\n</compact-fallback>`,
                },
              };
            }
          } catch {
            // fail-open
          }
        }

        // Skill suggestions are handled by the .cjs hook for now (needs daemon skill service)
        // TODO: port skill suggestion logic when full HTTP migration is complete

        return {};
      } catch {
        return {};
      }
    },

    // ═══════════════════════════════════════════════════════════════
    // Stop — record stop activity
    // ═══════════════════════════════════════════════════════════════
    'POST /api/hooks/stop': async (body) => {
      try {
        const input = parseRequestBody(HookBaseSchema, body);
        const cwd = fixWindowsPath(input.cwd || '');
        if (!cwd || !succExists(cwd)) return {};

        const sessionId = input.session_id;

        if (sessionId && ctx.sessionManager) {
          try {
            ctx.sessionManager.activity(sessionId, 'stop');
          } catch {
            // session not registered
          }
        }

        return {};
      } catch {
        return {};
      }
    },

    // ═══════════════════════════════════════════════════════════════
    // PermissionRequest — auto-approve/deny based on hook-rules
    // ═══════════════════════════════════════════════════════════════
    'POST /api/hooks/permission': async (body) => {
      try {
        const input = parseRequestBody(PermissionSchema, body);
        const cwd = fixWindowsPath(input.cwd || '');
        if (!cwd || !succExists(cwd)) return {};

        const toolName = input.tool_name || '';
        if (!toolName) return {};

        const toolInput =
          input.tool_input && typeof input.tool_input === 'object'
            ? (input.tool_input as Record<string, unknown>)
            : {};

        // Run command safety guard FIRST (deny always wins over allow rules)
        const command = (toolInput.command as string) || '';
        if (command) {
          const config = getConfig();
          const safetyConfig = extractSafetyConfig(config.commandSafetyGuard);
          const dangerResult = checkDangerous(command, safetyConfig);
          if (dangerResult && dangerResult.mode === 'deny') {
            ctx.log(`[hooks/permission] Safety guard denied: ${dangerResult.reason}`);
            return {
              hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision: {
                  behavior: 'deny',
                  message: `[succ guard] ${dangerResult.reason}`,
                },
              },
            };
          }
        }

        // Query hook-rules
        const memories = await getHookRuleMemories();
        const rules = matchRules(memories, toolName, toolInput);

        if (rules.length === 0) return {}; // pass-through to user

        // First rule wins (sorted: deny → ask → allow → inject)
        const topRule = rules[0];

        if (topRule.action === 'deny') {
          ctx.log(`[hooks/permission] Auto-denied ${toolName} by rule #${topRule.id}`);
          return {
            hookSpecificOutput: {
              hookEventName: 'PermissionRequest',
              decision: {
                behavior: 'deny',
                message: `Blocked by hook-rule #${topRule.id}: ${topRule.content}`,
              },
            },
          };
        }

        if (topRule.action === 'allow') {
          ctx.log(`[hooks/permission] Auto-approved ${toolName} by rule #${topRule.id}`);
          return {
            hookSpecificOutput: {
              hookEventName: 'PermissionRequest',
              decision: { behavior: 'allow' },
            },
          };
        }

        // 'ask' and 'inject' — pass-through to user dialog
        return {};
      } catch {
        return {};
      }
    },

    // ═══════════════════════════════════════════════════════════════
    // SubagentStop — save subagent results to memory
    // ═══════════════════════════════════════════════════════════════
    'POST /api/hooks/subagent-stop': async (body) => {
      try {
        const input = parseRequestBody(SubagentStopSchema, body);
        const cwd = fixWindowsPath(input.cwd || '');
        if (!cwd || !succExists(cwd)) return {};

        const agentType = input.agent_type || '';
        const toolOutput = input.tool_output || '';

        // Save results for exploration/planning agents
        if (
          toolOutput &&
          toolOutput.length > 50 &&
          (agentType.includes('Explore') ||
            agentType.includes('Plan') ||
            agentType.startsWith('succ-'))
        ) {
          try {
            const truncated =
              toolOutput.length > 2000 ? toolOutput.slice(0, 2000) + '...' : toolOutput;
            const content = `[${agentType} result] ${truncated}`;
            const embedding = await getEmbedding(content);
            await saveMemory(
              content,
              embedding,
              ['subagent', `agent:${agentType}`, 'auto-capture'],
              'auto-capture',
              { type: 'observation' }
            );
            ctx.log(`[hooks/subagent-stop] Saved ${agentType} result (${toolOutput.length} chars)`);
          } catch (err) {
            logWarn('hooks', 'Failed to save subagent result', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return {};
      } catch {
        return {};
      }
    },

    // ═══════════════════════════════════════════════════════════════
    // SessionStart — context assembly for HTTP hook mode
    // ═══════════════════════════════════════════════════════════════
    'POST /api/hooks/session-start': async (body) => {
      try {
        const input = parseRequestBody(HookBaseSchema, body);
        const cwd = fixWindowsPath(input.cwd || '');
        if (!cwd || !succExists(cwd)) return {};

        const succDir = path.join(cwd, '.succ');
        const projectName = path.basename(cwd);
        const contextParts: string[] = [];

        // Load config
        const config = getConfig();

        // Commit format (if enabled)
        if (config.includeCoAuthoredBy !== false) {
          contextParts.push(buildCommitContext());
        }

        // Soul document
        const soulPaths = [
          path.join(succDir, 'soul.md'),
          path.join(succDir, 'SOUL.md'),
          path.join(cwd, 'soul.md'),
          path.join(cwd, 'SOUL.md'),
        ];
        for (const soulPath of soulPaths) {
          if (fs.existsSync(soulPath)) {
            const soulContent = fs.readFileSync(soulPath, 'utf8').trim();
            if (soulContent) {
              contextParts.push('<soul>\n' + soulContent + '\n</soul>');
            }
            break;
          }
        }

        // Precomputed context from previous session
        const precomputedPath = path.join(succDir, 'next-session-context.md');
        if (fs.existsSync(precomputedPath)) {
          try {
            const precomputed = fs.readFileSync(precomputedPath, 'utf8').trim();
            if (precomputed) {
              contextParts.push('<previous-session>\n' + precomputed + '\n</previous-session>');
              // Archive
              const archiveDir = path.join(succDir, '.context-archive');
              if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
              const ts = new Date().toISOString().replace(/[:.]/g, '-');
              fs.renameSync(precomputedPath, path.join(archiveDir, `context-${ts}.md`));
            }
          } catch {
            // intentionally empty
          }
        }

        // Register session
        const transcriptPath = input.transcript_path || '';
        const sessionId = transcriptPath
          ? path.basename(transcriptPath, '.jsonl')
          : `session-${Date.now()}`;
        if (ctx.sessionManager) {
          ctx.sessionManager.register(sessionId, transcriptPath, false);
          ctx.log(`[hooks/session-start] Registered session: ${sessionId}`);
        }

        if (contextParts.length === 0) return {};

        const additionalContext = `<session project="${projectName}">\n${contextParts.join('\n\n')}\n</session>`;
        return {
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext,
          },
        };
      } catch (err) {
        logWarn('hooks', 'session-start failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return {};
      }
    },

    // ═══════════════════════════════════════════════════════════════
    // SessionEnd — unregister session + trigger processing
    // ═══════════════════════════════════════════════════════════════
    'POST /api/hooks/session-end': async (body) => {
      try {
        const input = parseRequestBody(HookBaseSchema, body);
        const cwd = fixWindowsPath(input.cwd || '');
        if (!cwd || !succExists(cwd)) return {};

        const transcriptPath = input.transcript_path || '';
        const sessionId = transcriptPath ? path.basename(transcriptPath, '.jsonl') : '';
        if (!sessionId) return {};

        if (ctx.sessionManager) {
          ctx.sessionManager.unregister(sessionId);
          ctx.clearBriefingCache(sessionId);
          removeBudget(sessionId);
          removeObservations(sessionId);
          flushBudgets();
          ctx.log(`[hooks/session-end] Unregistered session: ${sessionId}`);
        }

        return {};
      } catch {
        return {};
      }
    },

    // ═══════════════════════════════════════════════════════════════
    // TaskCompleted — save event + trigger memory curator
    // ═══════════════════════════════════════════════════════════════
    'POST /api/hooks/task-completed': async (body) => {
      try {
        const input = parseRequestBody(HookBaseSchema, body);
        const cwd = fixWindowsPath(input.cwd || '');
        if (!cwd || !succExists(cwd)) return {};

        ctx.log('[hooks/task-completed] Task completed, triggering memory curator');

        // Trigger memory curator in background (fire-and-forget)
        void (async () => {
          try {
            const curatorAgentPath = path.join(cwd, '.claude', 'agents', 'succ-memory-curator.md');

            if (!fs.existsSync(curatorAgentPath)) {
              ctx.log('[hooks/task-completed] Curator agent not found, skipping');
              return;
            }

            // SUCC_SERVICE_SESSION=1 is already set in CLAUDE_SPAWN_ENV (llm.ts)
            await spawnClaudeCLI(
              'Run memory curator: consolidate, deduplicate, link related memories, archive stale ones. Be thorough but fast.',
              { timeout: 120_000 }
            );
            ctx.log('[hooks/task-completed] Memory curator completed');
          } catch (err) {
            logWarn('hooks', 'Memory curator failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();

        return {};
      } catch {
        return {};
      }
    },
  };
}

export function resetHookRoutesState(): void {
  hookRulesCache = null;
}

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
        const input = parseRequestBody(HookBaseSchema, body);
        const cwd = fixWindowsPath(input.cwd || '');
        if (!cwd || !succExists(cwd)) return {};

        // PostToolUse logic is complex and tightly coupled to .cjs hook.
        // For now, forward key fields to existing daemon remember API.
        // Full port will happen incrementally.
        const toolName = ((body as Record<string, unknown>).tool_name as string) || '';
        const toolInput =
          ((body as Record<string, unknown>).tool_input as Record<string, unknown>) || {};
        const toolOutput = ((body as Record<string, unknown>).tool_output as string) || '';

        // Track activity (PostToolUse doesn't map to an ActivityType — skip)

        // Auto-capture git commits
        if (
          toolName === 'Bash' &&
          toolOutput &&
          /\bgit\s+commit\b/.test((toolInput.command as string) || '')
        ) {
          const commitMatch = toolOutput.match(/\[[\w/.-]+\s+([a-f0-9]+)\]\s+(.+)/);
          if (commitMatch) {
            const content = `Git commit ${commitMatch[1]}: ${commitMatch[2]}`;
            const embedding = await getEmbedding(content);
            await saveMemory(content, embedding, ['git', 'commit', 'auto-capture'], 'observation');
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

        // Also check command safety for Bash permission requests
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
              'observation'
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

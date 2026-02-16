/**
 * Dynamic Hook Rules — match memories tagged with "hook-rule" against tool calls.
 *
 * Convention:
 *   hook-rule          — required tag marking memory as a rule
 *   tool:{Name}        — optional, filter by tool (Edit, Write, Bash, Skill, etc.)
 *   match:{regex}      — optional, regex tested against tool input
 *
 * Action derived from memory type:
 *   error   → deny
 *   pattern → ask
 *   *       → inject (additionalContext)
 */

import path from 'path';
import type { Memory } from './storage/types.js';

export interface HookRule {
  id: number;
  content: string;
  type: string;
  tags: string[];
  action: 'inject' | 'deny' | 'ask';
}

const ACTION_ORDER: Record<string, number> = { deny: 0, ask: 1, inject: 2 };
/** Max regex pattern length to prevent ReDoS from user-authored patterns */
const MAX_REGEX_LENGTH = 200;

/**
 * Extract the match target string from tool input based on tool name.
 */
function getMatchTarget(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return (toolInput.command as string) || '';
    case 'Skill':
      return (toolInput.skill as string) || '';
    case 'Edit':
    case 'Write':
    case 'Read':
      return toolInput.file_path ? path.basename(toolInput.file_path as string) : '';
    case 'Task':
      return (toolInput.prompt as string) || '';
    default:
      return JSON.stringify(toolInput);
  }
}

/**
 * Map memory type to hook action.
 */
function typeToAction(type: string | null | undefined): 'inject' | 'deny' | 'ask' {
  if (type === 'error') return 'deny';
  if (type === 'pattern') return 'ask';
  return 'inject';
}

/**
 * Match hook-rule memories against a tool call.
 *
 * @param memories - All memories with the "hook-rule" tag
 * @param toolName - The tool being called (Edit, Write, Bash, Skill, etc.)
 * @param toolInput - The tool's input parameters
 * @returns Matched rules sorted: deny first, then ask, then inject
 */
export function matchRules(
  memories: Memory[],
  toolName: string,
  toolInput: Record<string, unknown>
): HookRule[] {
  const matchTarget = getMatchTarget(toolName, toolInput);
  const matched: HookRule[] = [];

  for (const mem of memories) {
    const tags = mem.tags || [];

    // Filter by tool:{Name} — case-insensitive
    const toolTags = tags.filter((t) => t.startsWith('tool:'));
    if (toolTags.length > 0) {
      const matchesTool = toolTags.some((t) => t.slice(5).toLowerCase() === toolName.toLowerCase());
      if (!matchesTool) continue;
    }

    // Filter by match:{regex}
    const matchTags = tags.filter((t) => t.startsWith('match:'));
    if (matchTags.length > 0) {
      let anyRegexMatches = false;
      for (const tag of matchTags) {
        const pattern = tag.slice(6);
        if (pattern.length > MAX_REGEX_LENGTH) continue; // ReDoS guard
        try {
          const re = new RegExp(pattern, 'i');
          if (re.test(matchTarget)) {
            anyRegexMatches = true;
            break;
          }
        } catch {
          // Invalid regex — skip this pattern
          continue;
        }
      }
      if (!anyRegexMatches) continue;
    }

    matched.push({
      id: mem.id,
      content: mem.content,
      type: mem.type || 'observation',
      tags,
      action: typeToAction(mem.type),
    });
  }

  // Sort: deny first, then ask, then inject
  matched.sort((a, b) => (ACTION_ORDER[a.action] ?? 2) - (ACTION_ORDER[b.action] ?? 2));

  return matched;
}

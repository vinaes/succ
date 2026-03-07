#!/usr/bin/env node
/**
 * Multi-Agent Hook Adapter — agent detection + I/O normalization.
 *
 * Allows succ hooks to work with Claude Code, Cursor, GitHub Copilot, and Gemini CLI.
 * CommonJS module, no npm dependencies, only Node.js built-ins.
 *
 * Usage in hooks:
 *   const adapter = require('./core/adapter.cjs');
 *   const agent = adapter.detectAgent(hookInput);
 *   const normalized = adapter.normalizeInput(agent, hookInput);
 *   // ... hook logic using normalized.cwd, normalized.tool_name, etc. ...
 *   const { json, exitCode } = adapter.formatOutput(agent, 'PreToolUse', result);
 *   console.log(JSON.stringify(json));
 *   process.exit(exitCode);
 */

'use strict';

// ─── Agent Detection ─────────────────────────────────────────────────

/**
 * Detect which AI coding agent is calling this hook.
 *
 * Priority:
 * 1. SUCC_AGENT env var (set by `succ setup <editor>`)
 * 2. Stdin JSON shape heuristics
 * 3. Default: 'claude'
 *
 * @param {object} [stdinJson] - Parsed stdin JSON (optional, for heuristic detection)
 * @returns {'claude'|'cursor'|'copilot'|'gemini'}
 */
function detectAgent(stdinJson) {
  const envAgent = process.env.SUCC_AGENT;
  if (envAgent) {
    const normalized = envAgent.toLowerCase().trim();
    if (normalized === 'cursor' || normalized === 'copilot' || normalized === 'gemini') {
      return normalized;
    }
    return 'claude';
  }

  // Heuristic detection from stdin JSON shape
  if (stdinJson && typeof stdinJson === 'object') {
    // Copilot: has separate bash/powershell fields in config, uses toolInput (camelCase)
    if ('toolInput' in stdinJson && 'hookEvent' in stdinJson) return 'copilot';
    // Cursor: uses event (camelCase), no hookSpecificOutput convention
    if ('event' in stdinJson && typeof stdinJson.event === 'string' && stdinJson.event.length > 0 && stdinJson.event[0] === stdinJson.event[0].toLowerCase()) return 'cursor';
    // Gemini: uses event (PascalCase)
    if ('event' in stdinJson && typeof stdinJson.event === 'string' && stdinJson.event.length > 0 && stdinJson.event[0] === stdinJson.event[0].toUpperCase()) return 'gemini';
  }

  return 'claude';
}

// ─── Tool Name Mapping ───────────────────────────────────────────────

/**
 * Map agent-specific tool names to succ canonical names (= Claude Code names).
 * Unknown names pass through unchanged.
 */
const TOOL_MAP = {
  cursor: {
    shell: 'Bash', Shell: 'Bash', terminal: 'Bash',
    edit: 'Edit', file_edit: 'Edit',
    write: 'Write', file_write: 'Write', create_file: 'Write',
    read: 'Read', file_read: 'Read', view: 'Read',
    grep: 'Grep', search: 'Grep',
    glob: 'Glob', list_files: 'Glob',
    task: 'Task', agent: 'Task',
  },
  copilot: {
    bash: 'Bash', shell: 'Bash', terminal: 'Bash',
    edit: 'Edit', editFile: 'Edit',
    write: 'Write', createFile: 'Write',
    view: 'Read', readFile: 'Read', read: 'Read',
    grep: 'Grep',
    glob: 'Glob',
  },
  gemini: {
    bash: 'Bash', shell: 'Bash',
    FileEdit: 'Edit', editFile: 'Edit', edit: 'Edit',
    FileWrite: 'Write', writeFile: 'Write', write: 'Write',
    FileRead: 'Read', readFile: 'Read', read: 'Read',
    grep: 'Grep', search: 'Grep',
    glob: 'Glob', listFiles: 'Glob',
  },
};

/**
 * Map agent-specific tool name to succ canonical name.
 * @param {'claude'|'cursor'|'copilot'|'gemini'} agent
 * @param {string} toolName
 * @returns {string} Canonical tool name
 */
function mapToolName(agent, toolName) {
  if (agent === 'claude' || !toolName) return toolName;
  const map = TOOL_MAP[agent];
  if (!map) return toolName;
  return map[toolName] || toolName;
}

// ─── Input Normalization ─────────────────────────────────────────────

/**
 * Normalize agent-specific stdin JSON to unified format (Claude's field names).
 *
 * @param {'claude'|'cursor'|'copilot'|'gemini'} agent
 * @param {object} stdinJson - Raw parsed stdin JSON
 * @returns {object} Normalized input with Claude-compatible field names
 */
function normalizeInput(agent, stdinJson) {
  if (agent === 'claude') return stdinJson;

  const normalized = { ...stdinJson };

  if (agent === 'cursor') {
    // Cursor uses camelCase: toolName, toolInput, toolOutput, etc.
    if (stdinJson.toolName !== undefined) normalized.tool_name = mapToolName('cursor', stdinJson.toolName);
    if (stdinJson.toolInput !== undefined) normalized.tool_input = stdinJson.toolInput;
    if (stdinJson.toolOutput !== undefined) normalized.tool_output = stdinJson.toolOutput;
    if (stdinJson.toolError !== undefined) normalized.tool_error = stdinJson.toolError;
    if (stdinJson.userPrompt !== undefined) normalized.prompt = stdinJson.userPrompt;
    if (stdinJson.message !== undefined && !normalized.prompt) normalized.prompt = stdinJson.message;
    if (stdinJson.sessionId !== undefined) normalized.session_id = stdinJson.sessionId;
    if (stdinJson.transcriptPath !== undefined) normalized.transcript_path = stdinJson.transcriptPath;
    // Cursor may use workingDirectory or cwd
    if (stdinJson.workingDirectory !== undefined && !normalized.cwd) normalized.cwd = stdinJson.workingDirectory;
  }

  if (agent === 'copilot') {
    // Copilot: toolInput (camelCase), hookEvent instead of hookEventName
    // CRITICAL: Copilot sends toolArgs as a double-encoded JSON string
    if (stdinJson.toolName !== undefined) normalized.tool_name = mapToolName('copilot', stdinJson.toolName);
    if (stdinJson.toolInput !== undefined) normalized.tool_input = stdinJson.toolInput;
    // Copilot toolArgs is a JSON string — parse it to get native object
    if (stdinJson.toolArgs !== undefined && typeof stdinJson.toolArgs === 'string') {
      try {
        normalized.tool_input = JSON.parse(stdinJson.toolArgs);
      } catch {
        normalized.tool_input = stdinJson.toolArgs;
      }
    }
    if (stdinJson.toolOutput !== undefined) normalized.tool_output = stdinJson.toolOutput;
    if (stdinJson.toolError !== undefined) normalized.tool_error = stdinJson.toolError;
    if (stdinJson.hookEvent !== undefined) normalized.hookEventName = stdinJson.hookEvent;
    if (stdinJson.userPrompt !== undefined) normalized.prompt = stdinJson.userPrompt;
    if (stdinJson.sessionId !== undefined) normalized.session_id = stdinJson.sessionId;
    if (stdinJson.workingDirectory !== undefined && !normalized.cwd) normalized.cwd = stdinJson.workingDirectory;
  }

  if (agent === 'gemini') {
    // Gemini uses PascalCase event names but otherwise similar to Claude
    if (stdinJson.toolName !== undefined) normalized.tool_name = mapToolName('gemini', stdinJson.toolName);
    if (stdinJson.toolInput !== undefined) normalized.tool_input = stdinJson.toolInput;
    if (stdinJson.toolOutput !== undefined) normalized.tool_output = stdinJson.toolOutput;
    if (stdinJson.toolError !== undefined) normalized.tool_error = stdinJson.toolError;
    if (stdinJson.userPrompt !== undefined) normalized.prompt = stdinJson.userPrompt;
    if (stdinJson.sessionId !== undefined) normalized.session_id = stdinJson.sessionId;
    if (stdinJson.workingDirectory !== undefined && !normalized.cwd) normalized.cwd = stdinJson.workingDirectory;
  }

  return normalized;
}

// ─── Output Formatting ───────────────────────────────────────────────

/**
 * Format a unified hook result into agent-specific stdout JSON + exit code.
 *
 * @param {'claude'|'cursor'|'copilot'|'gemini'} agent
 * @param {string} hookEvent - Hook event name ('PreToolUse', 'SessionStart', etc.)
 * @param {object} result - Unified result object:
 *   { additionalContext?: string, deny?: boolean, denyReason?: string,
 *     ask?: boolean, askReason?: string, suppressPrompt?: boolean }
 * @returns {{ json: object, exitCode: number }}
 */
function formatOutput(agent, hookEvent, result) {
  if (!result || (typeof result === 'object' && Object.keys(result).length === 0)) {
    return { json: {}, exitCode: 0 };
  }

  // ─── Claude Code ───
  if (agent === 'claude') {
    if (result.deny) {
      return {
        json: {
          hookSpecificOutput: {
            hookEventName: hookEvent,
            permissionDecision: 'deny',
            permissionDecisionReason: result.denyReason || 'Blocked by succ',
          },
        },
        exitCode: 0,
      };
    }
    if (result.ask) {
      return {
        json: {
          hookSpecificOutput: {
            hookEventName: hookEvent,
            permissionDecision: 'ask',
            permissionDecisionReason: result.askReason || '',
          },
        },
        exitCode: 0,
      };
    }
    if (result.additionalContext) {
      return {
        json: {
          hookSpecificOutput: {
            hookEventName: hookEvent,
            additionalContext: result.additionalContext,
          },
        },
        exitCode: 0,
      };
    }
    return { json: {}, exitCode: 0 };
  }

  // ─── Cursor ───
  // Docs: https://cursor.com/docs/hooks
  // Deny: {"permission": "deny", "user_message": "...", "agent_message": "..."} + exit(2)
  if (agent === 'cursor') {
    if (result.deny) {
      const reason = result.denyReason || 'Blocked by succ';
      return {
        json: { permission: 'deny', user_message: reason, agent_message: reason },
        exitCode: 2,
      };
    }
    if (result.ask) {
      return {
        json: { permission: 'ask', user_message: result.askReason || '' },
        exitCode: 0,
      };
    }
    if (result.additionalContext) {
      return {
        json: { additionalContext: result.additionalContext },
        exitCode: 0,
      };
    }
    return { json: {}, exitCode: 0 };
  }

  // ─── GitHub Copilot ───
  // Docs: https://docs.github.com/en/copilot/reference/hooks-configuration
  // Deny: {"permissionDecision": "deny", "permissionDecisionReason": "..."}
  // Only preToolUse processes stdout output — other hooks' output is ignored
  if (agent === 'copilot') {
    if (result.deny) {
      return {
        json: { permissionDecision: 'deny', permissionDecisionReason: result.denyReason || 'Blocked by succ' },
        exitCode: 0,
      };
    }
    if (result.ask) {
      return {
        json: { permissionDecision: 'ask', permissionDecisionReason: result.askReason || '' },
        exitCode: 0,
      };
    }
    if (result.additionalContext) {
      return {
        json: { systemMessage: result.additionalContext },
        exitCode: 0,
      };
    }
    return { json: {}, exitCode: 0 };
  }

  // ─── Gemini CLI ───
  // Docs: https://geminicli.com/docs/hooks/reference
  // Deny: {"decision": "deny", "reason": "..."} + exit(2)
  if (agent === 'gemini') {
    if (result.deny) {
      return {
        json: { decision: 'deny', reason: result.denyReason || 'Blocked by succ' },
        exitCode: 2,
      };
    }
    if (result.ask) {
      return {
        json: { decision: 'ask', reason: result.askReason || '' },
        exitCode: 0,
      };
    }
    if (result.additionalContext) {
      return {
        json: { systemMessage: result.additionalContext },
        exitCode: 0,
      };
    }
    return { json: {}, exitCode: 0 };
  }

  // Unknown agent — Claude format fallback
  return { json: {}, exitCode: 0 };
}

// ─── Context Adaptation ──────────────────────────────────────────────

/**
 * Strip Claude-specific sections from context for non-Claude agents.
 *
 * Removes:
 * - <succ-agents> section (non-Claude agents don't have Task/Agent tools)
 * - Subagent references in hook-rules examples
 *
 * @param {'claude'|'cursor'|'copilot'|'gemini'} agent
 * @param {string} context - Full context string
 * @returns {string} Adapted context
 */
function adaptContext(agent, context) {
  if (agent === 'claude' || !context) return context;

  let adapted = context;

  // Remove <succ-agents> section entirely
  adapted = adapted.replace(/<succ-agents[\s\S]*?<\/succ-agents>/g, '');

  // Remove subagent-related lines from hook-rules examples
  adapted = adapted.replace(/.*succ-diff-reviewer.*\n?/g, '');
  adapted = adapted.replace(/.*subagent_type=.*\n?/g, '');

  // Remove pre-commit review section (references succ-diff-reviewer agent)
  adapted = adapted.replace(/<pre-commit-review>[\s\S]*?<\/pre-commit-review>/g, '');

  // Clean up multiple blank lines
  adapted = adapted.replace(/\n{3,}/g, '\n\n');

  return adapted.trim();
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = {
  detectAgent,
  normalizeInput,
  mapToolName,
  formatOutput,
  adaptContext,
  TOOL_MAP,
};

/**
 * Per-action profile gating for consolidated MCP tools.
 *
 * Whole-tool gating lives in server.ts (applyToolProfile). This module handles
 * the finer-grained case: a tool is accessible at its base tier, but specific
 * actions within it require a higher tier.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Resolved profile state (set once by server.ts during init)
// ---------------------------------------------------------------------------

let resolvedProfile: 'core' | 'standard' | 'full' = 'full';

export function setResolvedProfile(profile: 'core' | 'standard' | 'full'): void {
  resolvedProfile = profile;
}

export function getResolvedProfile(): 'core' | 'standard' | 'full' {
  return resolvedProfile;
}

// ---------------------------------------------------------------------------
// Action-level gates
// ---------------------------------------------------------------------------

const TIER_ORDER: Record<string, number> = { core: 0, standard: 1, full: 2 };

/**
 * Map of tool → action → minimum required profile.
 * Only actions that need a HIGHER tier than the tool's base profile are listed.
 *
 * | Tool        | Base    | Gated actions                      | Required |
 * |-------------|---------|-------------------------------------|----------|
 * | succ_status | core    | stats, score                        | standard |
 * | succ_fetch  | core    | __extract (schema present)          | standard |
 * | succ_config | standard| checkpoint_create, checkpoint_list  | full     |
 * | succ_web    | standard| deep, history                       | full     |
 */
const ACTION_GATES: Record<string, Record<string, 'standard' | 'full'>> = {
  succ_status: { stats: 'standard', score: 'standard' },
  succ_fetch: { __extract: 'standard' },
  succ_config: { checkpoint_create: 'full', checkpoint_list: 'full' },
  succ_web: { deep: 'full', history: 'full' },
};

/**
 * Check whether the current profile allows a specific action on a tool.
 * Returns null if allowed, or an error CallToolResult if gated.
 */
export function gateAction(toolName: string, action: string): CallToolResult | null {
  const gates = ACTION_GATES[toolName];
  if (!gates) return null;

  const requiredTier = gates[action];
  if (!requiredTier) return null;

  if (TIER_ORDER[resolvedProfile] >= TIER_ORDER[requiredTier]) return null;

  return {
    content: [
      {
        type: 'text' as const,
        text:
          `Action "${action}" requires "${requiredTier}" profile (current: "${resolvedProfile}").\n\n` +
          `To enable:\n  succ_config(action="set", key="tool_profile", value="${requiredTier}")\n\n` +
          `Available profiles: core (8 tools), standard (12 tools), full (14 tools)`,
      },
    ],
    isError: true,
  };
}

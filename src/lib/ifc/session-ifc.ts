/**
 * Session IFC State — Bell-LaPadula enforcement per session
 *
 * Tracks the security high-water mark for each session:
 * - Labels only go UP (weak tranquility / monotonic)
 * - Taints accumulate and never clear
 * - Outbound operations are checked against *-property (no write down)
 * - Users can grant one-shot trusted-subject escalations
 *
 * State is in-memory, discarded on session end. New session = clean slate.
 */

import {
  type SecurityLabel,
  type SecurityLevel,
  type Compartment,
  makeLabel,
  join,
  dominates,
  isBottom,
  formatLabel,
  BOTTOM,
} from './label.js';

// ─── Types ──────────────────────────────────────────────────────────

export type SecurityTaint =
  | 'secrets_detected'
  | 'credentials_detected'
  | 'pii_detected'
  | 'prompt_injection'
  | 'high_entropy_output';

export interface LabelHistoryEntry {
  timestamp: number;
  previousLevel: SecurityLevel;
  newLevel: SecurityLevel;
  previousCompartments: Compartment[];
  newCompartments: Compartment[];
  trigger: string;
}

export interface SessionIFCState {
  label: SecurityLabel;
  taints: Set<SecurityTaint>;
  outboundStepCount: number;
  labelHistory: LabelHistoryEntry[];
  trustedActions: Set<string>;
  /** Permission mode registered at session start (trusted source of truth for bypass detection) */
  permissionMode?: string;
}

export type OutboundChannel =
  | 'file_write'
  | 'bash_network'
  | 'web_fetch'
  | 'git_commit'
  | 'memory_save';

export interface WriteDownCheckResult {
  allowed: boolean;
  action: 'allow' | 'deny' | 'ask' | 'warn';
  reason?: string;
}

export interface IFCStepLimits {
  highly_confidential: number;
  confidential: number;
}

const DEFAULT_STEP_LIMITS: IFCStepLimits = {
  highly_confidential: 25,
  confidential: 100,
};

/** Max label history entries to keep (prevents unbounded growth in long sessions) */
const MAX_LABEL_HISTORY = 200;

// ─── Destination labels for outbound channels ───────────────────────

const CHANNEL_LABELS: Record<OutboundChannel, SecurityLabel> = {
  file_write: BOTTOM, // Overridden by actual file label at check time
  bash_network: BOTTOM, // Network = public
  web_fetch: BOTTOM, // Network = public
  git_commit: BOTTOM, // Commit message = public
  memory_save: makeLabel(1), // Internal
};

// ─── State management ───────────────────────────────────────────────

export function createSessionIFC(): SessionIFCState {
  return {
    label: BOTTOM,
    taints: new Set(),
    outboundStepCount: 0,
    labelHistory: [],
    trustedActions: new Set(),
  };
}

/**
 * Raise the session label (monotonic — can only go up).
 * Returns true if the label actually changed.
 */
export function raiseLabel(
  state: SessionIFCState,
  fileLabel: SecurityLabel,
  trigger: string
): boolean {
  const newLabel = join(state.label, fileLabel);

  // Check if anything changed
  if (newLabel.level === state.label.level) {
    // Check compartments
    let changed = false;
    for (const c of newLabel.compartments) {
      if (!state.label.compartments.has(c)) {
        changed = true;
        break;
      }
    }
    if (!changed) return false;
  }

  // Record history (capped to prevent unbounded growth)
  if (state.labelHistory.length < MAX_LABEL_HISTORY) {
    state.labelHistory.push({
      timestamp: Date.now(),
      previousLevel: state.label.level,
      newLevel: newLabel.level,
      previousCompartments: [...state.label.compartments],
      newCompartments: [...newLabel.compartments],
      trigger,
    });
  }

  state.label = newLabel;
  return true;
}

/**
 * Add a taint to the session (accumulative, never removed).
 */
export function addTaint(state: SessionIFCState, taint: SecurityTaint, source: string): void {
  if (state.taints.has(taint)) return;
  state.taints.add(taint);

  // Auto-raise label based on taint
  switch (taint) {
    case 'secrets_detected':
      raiseLabel(state, makeLabel(3, ['secrets']), `taint:${taint} from ${source}`);
      break;
    case 'credentials_detected':
      raiseLabel(state, makeLabel(3, ['credentials']), `taint:${taint} from ${source}`);
      break;
    case 'pii_detected':
      raiseLabel(state, makeLabel(2, ['pii']), `taint:${taint} from ${source}`);
      break;
    case 'prompt_injection':
      // Injection doesn't change label, but taints the session
      break;
    case 'high_entropy_output':
      raiseLabel(state, makeLabel(2, ['secrets']), `taint:${taint} from ${source}`);
      break;
  }
}

/**
 * Grant a one-shot trusted-subject escalation.
 * The action ID should be unique per operation (e.g., "bash:curl:step42").
 */
export function grantTrustedAction(state: SessionIFCState, actionId: string): void {
  state.trustedActions.add(actionId);
}

/**
 * Consume a trusted action (one-shot — removed after use).
 * Returns true if the action was granted and is now consumed.
 */
export function consumeTrustedAction(state: SessionIFCState, actionId: string): boolean {
  return state.trustedActions.delete(actionId);
}

// ─── *-Property enforcement (no write down) ─────────────────────────

/**
 * Check if an outbound operation is allowed under BLP *-property.
 *
 * Graduated enforcement:
 * - highly_confidential (3): deny all outbound unconditionally
 * - confidential (2): deny if tainted, ask otherwise
 * - internal (1): warn only
 * - public (0): no restriction
 *
 * For file_write, caller must provide the destination file's label.
 */
export function checkWriteDown(
  state: SessionIFCState,
  channel: OutboundChannel,
  options: {
    destinationLabel?: SecurityLabel;
    actionId?: string;
    stepLimits?: Partial<IFCStepLimits>;
  } = {}
): WriteDownCheckResult {
  // If session is at bottom (clean), always allow
  if (isBottom(state.label)) {
    return { allowed: true, action: 'allow' };
  }

  // Check one-shot trusted action (consumed on use — delete, not has)
  if (options.actionId && state.trustedActions.delete(options.actionId)) {
    return {
      allowed: true,
      action: 'allow',
      reason: 'Trusted action granted by user (one-shot, now consumed)',
    };
  }

  // Determine destination label
  const destLabel =
    channel === 'file_write' && options.destinationLabel
      ? options.destinationLabel
      : CHANNEL_LABELS[channel];

  // For file_write: check if destination dominates session (standard BLP)
  if (channel === 'file_write' && options.destinationLabel) {
    if (dominates(options.destinationLabel, state.label)) {
      // Writing to equal or higher classification — always OK
      return { allowed: true, action: 'allow' };
    }
  }

  // Graduated enforcement by session level
  const limits = { ...DEFAULT_STEP_LIMITS, ...options.stepLimits };

  if (state.label.level === 3) {
    // Highly confidential: deny all outbound (except file_write to same/higher level)
    if (state.outboundStepCount >= limits.highly_confidential) {
      return {
        allowed: false,
        action: 'deny',
        reason:
          `Session has read highly confidential data (step limit ${limits.highly_confidential} reached). ` +
          `All outbound operations blocked. Session label: ${formatLabel(state.label)}`,
      };
    }
    return {
      allowed: false,
      action: 'deny',
      reason:
        `Session has read highly confidential data. ` +
        `${channel} to ${formatLabel(destLabel)} blocked (no write down). ` +
        `Session label: ${formatLabel(state.label)}`,
    };
  }

  if (state.label.level === 2) {
    // Confidential: deny if tainted, ask otherwise
    if (state.taints.size > 0) {
      return {
        allowed: false,
        action: 'deny',
        reason:
          `Session is confidential + tainted (${[...state.taints].join(', ')}). ` +
          `${channel} blocked. Session label: ${formatLabel(state.label)}`,
      };
    }

    if (state.outboundStepCount >= limits.confidential) {
      return {
        allowed: false,
        action: 'ask',
        reason:
          `Session has read confidential data (step limit ${limits.confidential} approaching). ` +
          `${channel} requires approval. Session label: ${formatLabel(state.label)}`,
      };
    }

    return {
      allowed: false,
      action: 'ask',
      reason:
        `Session has read confidential data. ` +
        `${channel} to ${formatLabel(destLabel)} requires approval (no write down). ` +
        `Session label: ${formatLabel(state.label)}`,
    };
  }

  if (state.label.level === 1) {
    // Internal: warn only (don't block)
    return {
      allowed: true,
      action: 'warn',
      reason:
        `Session has read internal data. ` +
        `${channel} allowed but noted. Session label: ${formatLabel(state.label)}`,
    };
  }

  // Level 0 (public) — no restriction
  return { allowed: true, action: 'allow' };
}

/**
 * Increment outbound step counter. Call after every outbound operation.
 */
export function recordOutboundStep(state: SessionIFCState): void {
  state.outboundStepCount++;
}

// ─── Serialization (for API responses) ──────────────────────────────

export interface SessionIFCSummary {
  level: SecurityLevel;
  levelName: string;
  compartments: Compartment[];
  taints: SecurityTaint[];
  outboundStepCount: number;
  historyLength: number;
  trustedActionsCount: number;
  formattedLabel: string;
}

export function summarizeIFC(state: SessionIFCState): SessionIFCSummary {
  return {
    level: state.label.level,
    levelName: formatLabel(state.label).split(' ')[0],
    compartments: [...state.label.compartments] as Compartment[],
    taints: [...state.taints],
    outboundStepCount: state.outboundStepCount,
    historyLength: state.labelHistory.length,
    trustedActionsCount: state.trustedActions.size,
    formattedLabel: formatLabel(state.label),
  };
}

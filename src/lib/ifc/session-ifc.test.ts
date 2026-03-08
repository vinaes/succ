/**
 * Session IFC State — unit tests
 */

import { describe, it, expect } from 'vitest';
import {
  createSessionIFC,
  raiseLabel,
  addTaint,
  grantTrustedAction,
  consumeTrustedAction,
  checkWriteDown,
  recordOutboundStep,
  summarizeIFC,
} from './session-ifc.js';
import { makeLabel, isBottom, BOTTOM } from './label.js';

describe('createSessionIFC', () => {
  it('starts at BOTTOM', () => {
    const state = createSessionIFC();
    expect(isBottom(state.label)).toBe(true);
    expect(state.taints.size).toBe(0);
    expect(state.outboundStepCount).toBe(0);
    expect(state.labelHistory).toHaveLength(0);
    expect(state.trustedActions.size).toBe(0);
  });
});

describe('raiseLabel', () => {
  it('raises label from BOTTOM', () => {
    const state = createSessionIFC();
    const changed = raiseLabel(state, makeLabel(2, ['secrets']), 'test');
    expect(changed).toBe(true);
    expect(state.label.level).toBe(2);
    expect(state.label.compartments.has('secrets')).toBe(true);
  });

  it('is monotonic — cannot lower level', () => {
    const state = createSessionIFC();
    raiseLabel(state, makeLabel(3, ['secrets']), 'first');
    raiseLabel(state, makeLabel(1), 'second');
    expect(state.label.level).toBe(3);
  });

  it('accumulates compartments', () => {
    const state = createSessionIFC();
    raiseLabel(state, makeLabel(1, ['secrets']), 'first');
    raiseLabel(state, makeLabel(2, ['pii']), 'second');
    expect(state.label.level).toBe(2);
    expect(state.label.compartments.has('secrets')).toBe(true);
    expect(state.label.compartments.has('pii')).toBe(true);
  });

  it('returns false when nothing changes', () => {
    const state = createSessionIFC();
    raiseLabel(state, makeLabel(2, ['secrets']), 'first');
    const changed = raiseLabel(state, makeLabel(1, ['secrets']), 'second');
    expect(changed).toBe(false);
  });

  it('records history on change', () => {
    const state = createSessionIFC();
    raiseLabel(state, makeLabel(1, ['secrets']), 'read .env');
    raiseLabel(state, makeLabel(3, ['credentials']), 'read .pem');
    expect(state.labelHistory).toHaveLength(2);
    expect(state.labelHistory[0].trigger).toBe('read .env');
    expect(state.labelHistory[1].newLevel).toBe(3);
  });

  it('does not record history when nothing changes', () => {
    const state = createSessionIFC();
    raiseLabel(state, makeLabel(2, ['secrets']), 'first');
    raiseLabel(state, makeLabel(1), 'no-op');
    expect(state.labelHistory).toHaveLength(1);
  });
});

describe('addTaint', () => {
  it('adds taint and auto-raises label', () => {
    const state = createSessionIFC();
    addTaint(state, 'secrets_detected', 'bash output');
    expect(state.taints.has('secrets_detected')).toBe(true);
    expect(state.label.level).toBe(3);
    expect(state.label.compartments.has('secrets')).toBe(true);
  });

  it('accumulates multiple taints', () => {
    const state = createSessionIFC();
    addTaint(state, 'secrets_detected', 'source1');
    addTaint(state, 'pii_detected', 'source2');
    expect(state.taints.size).toBe(2);
    expect(state.label.compartments.has('secrets')).toBe(true);
    expect(state.label.compartments.has('pii')).toBe(true);
  });

  it('is idempotent — same taint added twice has no effect', () => {
    const state = createSessionIFC();
    addTaint(state, 'secrets_detected', 'first');
    addTaint(state, 'secrets_detected', 'second');
    expect(state.taints.size).toBe(1);
  });

  it('prompt_injection taint does not change label', () => {
    const state = createSessionIFC();
    addTaint(state, 'prompt_injection', 'tool output');
    expect(state.taints.has('prompt_injection')).toBe(true);
    expect(isBottom(state.label)).toBe(true);
  });

  it('credentials_detected raises to level 3 with credentials', () => {
    const state = createSessionIFC();
    addTaint(state, 'credentials_detected', 'bash output');
    expect(state.label.level).toBe(3);
    expect(state.label.compartments.has('credentials')).toBe(true);
  });
});

describe('trusted actions', () => {
  it('grants and consumes one-shot action', () => {
    const state = createSessionIFC();
    grantTrustedAction(state, 'bash:curl:step42');
    expect(consumeTrustedAction(state, 'bash:curl:step42')).toBe(true);
    // Second consume fails (one-shot)
    expect(consumeTrustedAction(state, 'bash:curl:step42')).toBe(false);
  });

  it('consume returns false for non-existent action', () => {
    const state = createSessionIFC();
    expect(consumeTrustedAction(state, 'nonexistent')).toBe(false);
  });
});

describe('checkWriteDown', () => {
  describe('public session (BOTTOM)', () => {
    it('allows all outbound at BOTTOM', () => {
      const state = createSessionIFC();
      expect(checkWriteDown(state, 'bash_network').allowed).toBe(true);
      expect(checkWriteDown(state, 'web_fetch').allowed).toBe(true);
      expect(checkWriteDown(state, 'git_commit').allowed).toBe(true);
      expect(checkWriteDown(state, 'memory_save').allowed).toBe(true);
    });
  });

  describe('internal session (level 1)', () => {
    it('allows with warning', () => {
      const state = createSessionIFC();
      raiseLabel(state, makeLabel(1, ['internal_infra']), 'test');
      const result = checkWriteDown(state, 'bash_network');
      expect(result.allowed).toBe(true);
      expect(result.action).toBe('warn');
    });
  });

  describe('confidential session (level 2)', () => {
    it('asks when not tainted', () => {
      const state = createSessionIFC();
      raiseLabel(state, makeLabel(2, ['secrets']), 'read .env');
      const result = checkWriteDown(state, 'bash_network');
      expect(result.allowed).toBe(false);
      expect(result.action).toBe('ask');
    });

    it('denies when tainted', () => {
      const state = createSessionIFC();
      raiseLabel(state, makeLabel(2, ['secrets']), 'read .env');
      addTaint(state, 'secrets_detected', 'output');
      // Label is now 3 from taint auto-raise, so it should deny
      const result = checkWriteDown(state, 'bash_network');
      expect(result.allowed).toBe(false);
      expect(result.action).toBe('deny');
    });
  });

  describe('highly confidential session (level 3)', () => {
    it('denies all outbound', () => {
      const state = createSessionIFC();
      raiseLabel(state, makeLabel(3, ['credentials']), 'read .pem');
      expect(checkWriteDown(state, 'bash_network').action).toBe('deny');
      expect(checkWriteDown(state, 'web_fetch').action).toBe('deny');
      expect(checkWriteDown(state, 'git_commit').action).toBe('deny');
    });
  });

  describe('file_write channel', () => {
    it('allows write to equal-or-higher classification', () => {
      const state = createSessionIFC();
      raiseLabel(state, makeLabel(2, ['secrets']), 'read .env');
      const result = checkWriteDown(state, 'file_write', {
        destinationLabel: makeLabel(3, ['secrets', 'credentials']),
      });
      expect(result.allowed).toBe(true);
    });

    it('asks write to lower classification (no write down)', () => {
      const state = createSessionIFC();
      raiseLabel(state, makeLabel(2, ['secrets']), 'read .env');
      const result = checkWriteDown(state, 'file_write', {
        destinationLabel: BOTTOM,
      });
      expect(result.allowed).toBe(false);
      expect(result.action).toBe('ask');
    });
  });

  describe('trusted action override', () => {
    it('allows denied operation with trusted action', () => {
      const state = createSessionIFC();
      raiseLabel(state, makeLabel(3, ['credentials']), 'read .pem');
      grantTrustedAction(state, 'bash:curl:step1');
      const result = checkWriteDown(state, 'bash_network', { actionId: 'bash:curl:step1' });
      expect(result.allowed).toBe(true);
    });
  });
});

describe('recordOutboundStep', () => {
  it('increments step count', () => {
    const state = createSessionIFC();
    recordOutboundStep(state);
    recordOutboundStep(state);
    recordOutboundStep(state);
    expect(state.outboundStepCount).toBe(3);
  });
});

describe('summarizeIFC', () => {
  it('summarizes clean session', () => {
    const state = createSessionIFC();
    const summary = summarizeIFC(state);
    expect(summary.level).toBe(0);
    expect(summary.compartments).toEqual([]);
    expect(summary.taints).toEqual([]);
    expect(summary.outboundStepCount).toBe(0);
    expect(summary.formattedLabel).toBe('public');
  });

  it('summarizes tainted session', () => {
    const state = createSessionIFC();
    raiseLabel(state, makeLabel(2, ['secrets', 'pii']), 'test');
    addTaint(state, 'prompt_injection', 'test');
    recordOutboundStep(state);
    const summary = summarizeIFC(state);
    expect(summary.level).toBe(2);
    expect(summary.compartments).toContain('secrets');
    expect(summary.compartments).toContain('pii');
    expect(summary.taints).toContain('prompt_injection');
    expect(summary.outboundStepCount).toBe(1);
    expect(summary.historyLength).toBe(1);
  });
});

/**
 * Bell-LaPadula Label Lattice — unit tests
 */

import { describe, it, expect } from 'vitest';
import {
  makeLabel,
  join,
  dominates,
  isBottom,
  isComparable,
  labelsEqual,
  formatLabel,
  BOTTOM,
  type SecurityLabel,
} from './label.js';

describe('makeLabel', () => {
  it('creates a label with level and compartments', () => {
    const label = makeLabel(2, ['secrets', 'pii']);
    expect(label.level).toBe(2);
    expect(label.compartments.has('secrets')).toBe(true);
    expect(label.compartments.has('pii')).toBe(true);
    expect(label.compartments.size).toBe(2);
  });

  it('creates a label with no compartments by default', () => {
    const label = makeLabel(1);
    expect(label.level).toBe(1);
    expect(label.compartments.size).toBe(0);
  });
});

describe('BOTTOM', () => {
  it('is level 0 with no compartments', () => {
    expect(BOTTOM.level).toBe(0);
    expect(BOTTOM.compartments.size).toBe(0);
  });
});

describe('join (Least Upper Bound)', () => {
  it('returns max level', () => {
    const a = makeLabel(1, ['secrets']);
    const b = makeLabel(3, ['pii']);
    const result = join(a, b);
    expect(result.level).toBe(3);
  });

  it('returns union of compartments', () => {
    const a = makeLabel(1, ['secrets']);
    const b = makeLabel(2, ['pii', 'credentials']);
    const result = join(a, b);
    expect(result.compartments.has('secrets')).toBe(true);
    expect(result.compartments.has('pii')).toBe(true);
    expect(result.compartments.has('credentials')).toBe(true);
    expect(result.compartments.size).toBe(3);
  });

  it('join with BOTTOM returns the other', () => {
    const a = makeLabel(2, ['secrets']);
    const result = join(a, BOTTOM);
    expect(result.level).toBe(2);
    expect(result.compartments.has('secrets')).toBe(true);
    expect(result.compartments.size).toBe(1);
  });

  it('join is commutative', () => {
    const a = makeLabel(1, ['secrets']);
    const b = makeLabel(2, ['pii']);
    const ab = join(a, b);
    const ba = join(b, a);
    expect(labelsEqual(ab, ba)).toBe(true);
  });

  it('join is associative', () => {
    const a = makeLabel(1, ['secrets']);
    const b = makeLabel(2, ['pii']);
    const c = makeLabel(3, ['credentials']);
    const ab_c = join(join(a, b), c);
    const a_bc = join(a, join(b, c));
    expect(labelsEqual(ab_c, a_bc)).toBe(true);
  });

  it('join is idempotent', () => {
    const a = makeLabel(2, ['secrets', 'pii']);
    const result = join(a, a);
    expect(labelsEqual(result, a)).toBe(true);
  });
});

describe('dominates', () => {
  it('higher level + superset compartments dominates', () => {
    const high = makeLabel(3, ['secrets', 'pii', 'credentials']);
    const low = makeLabel(2, ['secrets', 'pii']);
    expect(dominates(high, low)).toBe(true);
  });

  it('same level + same compartments dominates', () => {
    const a = makeLabel(2, ['secrets']);
    const b = makeLabel(2, ['secrets']);
    expect(dominates(a, b)).toBe(true);
  });

  it('lower level does NOT dominate', () => {
    const low = makeLabel(1, ['secrets', 'pii', 'credentials']);
    const high = makeLabel(2, []);
    expect(dominates(low, high)).toBe(false);
  });

  it('missing compartment does NOT dominate', () => {
    const a = makeLabel(3, ['secrets']);
    const b = makeLabel(1, ['pii']);
    expect(dominates(a, b)).toBe(false);
  });

  it('BOTTOM is dominated by everything', () => {
    expect(dominates(makeLabel(0), BOTTOM)).toBe(true);
    expect(dominates(makeLabel(1, ['secrets']), BOTTOM)).toBe(true);
    expect(dominates(makeLabel(3, ['secrets', 'credentials', 'pii', 'internal_infra']), BOTTOM)).toBe(true);
  });

  it('everything dominates BOTTOM', () => {
    expect(dominates(BOTTOM, BOTTOM)).toBe(true);
  });

  it('BOTTOM does NOT dominate non-BOTTOM', () => {
    expect(dominates(BOTTOM, makeLabel(1))).toBe(false);
    expect(dominates(BOTTOM, makeLabel(0, ['secrets']))).toBe(false);
  });
});

describe('isBottom', () => {
  it('returns true for BOTTOM', () => {
    expect(isBottom(BOTTOM)).toBe(true);
  });

  it('returns true for equivalent bottom', () => {
    expect(isBottom(makeLabel(0))).toBe(true);
  });

  it('returns false for non-zero level', () => {
    expect(isBottom(makeLabel(1))).toBe(false);
  });

  it('returns false for level 0 with compartments', () => {
    expect(isBottom(makeLabel(0, ['secrets']))).toBe(false);
  });
});

describe('isComparable', () => {
  it('returns true when a dominates b', () => {
    const a = makeLabel(3, ['secrets', 'pii']);
    const b = makeLabel(2, ['secrets']);
    expect(isComparable(a, b)).toBe(true);
  });

  it('returns true when b dominates a', () => {
    const a = makeLabel(1);
    const b = makeLabel(2, ['secrets']);
    expect(isComparable(a, b)).toBe(true);
  });

  it('returns true for equal labels', () => {
    const a = makeLabel(2, ['secrets']);
    const b = makeLabel(2, ['secrets']);
    expect(isComparable(a, b)).toBe(true);
  });

  it('returns false for incomparable labels (different compartments, neither dominates)', () => {
    const a = makeLabel(2, ['secrets']);
    const b = makeLabel(2, ['pii']);
    expect(isComparable(a, b)).toBe(false);
  });

  it('returns false for cross — higher level but fewer compartments', () => {
    const a = makeLabel(3, ['secrets']);
    const b = makeLabel(1, ['pii']);
    expect(isComparable(a, b)).toBe(false);
  });
});

describe('labelsEqual', () => {
  it('returns true for identical labels', () => {
    expect(labelsEqual(makeLabel(2, ['secrets', 'pii']), makeLabel(2, ['secrets', 'pii']))).toBe(true);
  });

  it('returns false for different levels', () => {
    expect(labelsEqual(makeLabel(1, ['secrets']), makeLabel(2, ['secrets']))).toBe(false);
  });

  it('returns false for different compartments', () => {
    expect(labelsEqual(makeLabel(2, ['secrets']), makeLabel(2, ['pii']))).toBe(false);
  });

  it('returns false for different compartment count', () => {
    expect(labelsEqual(makeLabel(2, ['secrets']), makeLabel(2, ['secrets', 'pii']))).toBe(false);
  });
});

describe('formatLabel', () => {
  it('formats BOTTOM as "public"', () => {
    expect(formatLabel(BOTTOM)).toBe('public');
  });

  it('formats level-only label', () => {
    expect(formatLabel(makeLabel(2))).toBe('confidential');
  });

  it('formats label with compartments (sorted)', () => {
    const label = makeLabel(3, ['pii', 'credentials', 'secrets']);
    expect(formatLabel(label)).toBe('highly_confidential {credentials, pii, secrets}');
  });

  it('formats single compartment', () => {
    expect(formatLabel(makeLabel(1, ['internal_infra']))).toBe('internal {internal_infra}');
  });
});

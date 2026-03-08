/**
 * Bell-LaPadula Security Label Lattice
 *
 * Full BLP model with compartments:
 * - SecurityLevel: 0=public, 1=internal, 2=confidential, 3=highly_confidential
 * - Compartments: secrets, credentials, pii, internal_infra
 * - Lattice operations: join (LUB), dominates, isBottom, isComparable
 *
 * Label rules:
 * - Labels only go UP (weak tranquility)
 * - join(a, b) = max level + union compartments
 * - dominates(a, b) = a.level >= b.level AND a.compartments ⊇ b.compartments
 */

export type SecurityLevel = 0 | 1 | 2 | 3;

export const LEVEL_NAMES: Record<SecurityLevel, string> = {
  0: 'public',
  1: 'internal',
  2: 'confidential',
  3: 'highly_confidential',
};

export type Compartment = 'secrets' | 'credentials' | 'pii' | 'internal_infra';

export const ALL_COMPARTMENTS: readonly Compartment[] = [
  'secrets',
  'credentials',
  'pii',
  'internal_infra',
] as const;

export interface SecurityLabel {
  readonly level: SecurityLevel;
  readonly compartments: ReadonlySet<Compartment>;
}

/** The bottom of the lattice — no classification, no compartments */
export const BOTTOM: SecurityLabel = Object.freeze({
  level: 0,
  compartments: Object.freeze(new Set<Compartment>()),
}) as SecurityLabel;

/** Create a label */
export function makeLabel(level: SecurityLevel, compartments: Compartment[] = []): SecurityLabel {
  return {
    level,
    compartments: new Set(compartments),
  };
}

/** Least Upper Bound — max level, union of compartments */
export function join(a: SecurityLabel, b: SecurityLabel): SecurityLabel {
  const level = Math.max(a.level, b.level) as SecurityLevel;
  const compartments = new Set<Compartment>([...a.compartments, ...b.compartments]);
  return { level, compartments };
}

/** Does `a` dominate `b`? (a.level >= b.level AND a.compartments ⊇ b.compartments) */
export function dominates(a: SecurityLabel, b: SecurityLabel): boolean {
  if (a.level < b.level) return false;
  for (const c of b.compartments) {
    if (!a.compartments.has(c)) return false;
  }
  return true;
}

/** Is label at the bottom of the lattice? */
export function isBottom(label: SecurityLabel): boolean {
  return label.level === 0 && label.compartments.size === 0;
}

/** Are two labels comparable? (one dominates the other) */
export function isComparable(a: SecurityLabel, b: SecurityLabel): boolean {
  return dominates(a, b) || dominates(b, a);
}

/** Are two labels equal? */
export function labelsEqual(a: SecurityLabel, b: SecurityLabel): boolean {
  if (a.level !== b.level) return false;
  if (a.compartments.size !== b.compartments.size) return false;
  for (const c of a.compartments) {
    if (!b.compartments.has(c)) return false;
  }
  return true;
}

/** Format label for display */
export function formatLabel(label: SecurityLabel): string {
  const level = LEVEL_NAMES[label.level];
  const comps = [...label.compartments].sort().join(', ');
  return comps ? `${level} {${comps}}` : level;
}

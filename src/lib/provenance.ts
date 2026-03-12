/**
 * Shared provenance normalization helper.
 *
 * Centralizes confidence clamping ([0, 1] → default 0.5) and sourceType
 * validation (falls back to 'human') so all storage backends apply the same
 * rules without duplicating the logic.
 */

import { SOURCE_TYPES } from './storage/types.js';
import type { SourceType } from './storage/types.js';

export function normalizeProvenance(
  rawConfidence: number | undefined,
  rawSourceType: string | undefined
): { confidence: number; sourceType: SourceType } {
  const confidence =
    rawConfidence !== undefined &&
    Number.isFinite(rawConfidence) &&
    rawConfidence >= 0 &&
    rawConfidence <= 1
      ? rawConfidence
      : 0.5;

  const sourceType: SourceType = (SOURCE_TYPES as readonly string[]).includes(rawSourceType ?? '')
    ? (rawSourceType as SourceType)
    : 'human';

  return { confidence, sourceType };
}

/**
 * Shared pairwise similarity utilities for memory consolidation.
 */

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

/**
 * Find all pairs above similarity threshold. O(n²).
 */
export function findSimilarPairs(
  items: Array<{ id: number; embedding: number[] }>,
  threshold: number
): Array<{ a: number; b: number; similarity: number }> {
  const pairs: Array<{ a: number; b: number; similarity: number }> = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const sim = cosineSimilarity(items[i].embedding, items[j].embedding);
      if (sim >= threshold) {
        pairs.push({ a: items[i].id, b: items[j].id, similarity: sim });
      }
    }
  }
  return pairs;
}

/**
 * Group similar pairs into transitive clusters using Union-Find.
 */
export function groupByUnionFind(pairs: Array<{ a: number; b: number }>): Map<number, number[]> {
  const parent = new Map<number, number>();

  function find(x: number): number {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
    return parent.get(x)!;
  }

  function union(x: number, y: number): void {
    const px = find(x),
      py = find(y);
    if (px !== py) parent.set(px, py);
  }

  for (const { a, b } of pairs) {
    union(a, b);
  }

  const groups = new Map<number, number[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(id);
  }

  return groups;
}

/**
 * Worker thread for parallel cosine similarity calculations
 *
 * Used by consolidation and auto-linking to speed up O(n²) comparisons
 */

import { parentPort, workerData } from 'worker_threads';

interface WorkerData {
  pairs: Array<[number, number]>;
  embeddings: number[][];
  threshold: number;
}

interface SimilarityResult {
  i: number;
  j: number;
  similarity: number;
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

// Main worker logic
if (parentPort) {
  const { pairs, embeddings, threshold } = workerData as WorkerData;

  const results: SimilarityResult[] = [];

  for (const [i, j] of pairs) {
    const similarity = cosineSimilarity(embeddings[i], embeddings[j]);
    if (similarity >= threshold) {
      results.push({ i, j, similarity });
    }
  }

  parentPort.postMessage(results);
}

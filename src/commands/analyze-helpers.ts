/**
 * Helper functions for recursive file analysis.
 * Extracted for testability (analyze.ts has heavy imports that cause module context issues in vitest).
 */

/**
 * Format symbol map from tree-sitter extraction for LLM context
 */
export function formatSymbolMap(symbols: Array<{ name: string; type: string; signature?: string; startRow: number }>): string {
  if (symbols.length === 0) return '(no symbols extracted)';
  return symbols
    .map(s => `  ${s.type} ${s.name}${s.signature ? s.signature : ''} (line ${s.startRow + 1})`)
    .join('\n');
}

/**
 * Batch chunks into groups that fit within a char budget.
 * Each batch contains consecutive chunks whose total content.length ≤ maxChars.
 * A single chunk larger than maxChars goes into its own batch.
 */
export function batchChunks<T extends { content: string }>(chunks: T[], maxChars: number): T[][] {
  const batches: T[][] = [];
  let currentBatch: T[] = [];
  let currentSize = 0;

  for (const chunk of chunks) {
    if (currentSize + chunk.content.length > maxChars && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentSize = 0;
    }
    currentBatch.push(chunk);
    currentSize += chunk.content.length;
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  return batches;
}

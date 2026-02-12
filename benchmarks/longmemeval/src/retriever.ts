/**
 * Memory retriever — query succ's hybrid search for benchmark answers
 */

import { hybridSearchMemories } from '../../../src/lib/storage/index.js';
import { getEmbedding } from '../../../src/lib/embeddings.js';

export interface RetrievalResult {
  memories: Array<{ content: string; similarity: number; created_at?: string }>;
  contextBlock: string;
}

/**
 * Retrieve relevant memories for a benchmark question.
 * Returns formatted context block for the answering LLM.
 */
export async function retrieveMemories(
  question: string,
  topK: number = 10,
  threshold: number = 0.1,
  alpha: number = 0.3,
): Promise<RetrievalResult> {
  const queryEmbedding = await getEmbedding(question);
  const memories = await hybridSearchMemories(question, queryEmbedding, topK, threshold, alpha);

  // Format memories into a context block
  const contextLines: string[] = [];
  for (const mem of memories) {
    const score = mem.similarity.toFixed(3);
    const date = mem.created_at ? ` [${mem.created_at}]` : '';
    contextLines.push(`- [${score}]${date} ${mem.content}`);
  }

  const contextBlock = contextLines.length > 0
    ? `Relevant information from conversation history:\n${contextLines.join('\n')}`
    : 'No relevant information found in conversation history.';

  return { memories, contextBlock };
}

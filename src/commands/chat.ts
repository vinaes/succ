import { searchDocuments, closeDb } from '../lib/storage/index.js';
import { getEmbedding } from '../lib/embeddings.js';
import { callLLMChat, ChatMessage } from '../lib/llm.js';
import { CHAT_SYSTEM_PROMPT } from '../prompts/index.js';
import { logError } from '../lib/fault-logger.js';

interface ChatOptions {
  limit?: number;
  threshold?: number;
  verbose?: boolean;
}

/**
 * RAG chat - search context + unified LLM
 *
 * Uses the chat_llm config for interactive chat.
 * Falls back to main llm config if chat_llm not configured.
 */
export async function chat(
  query: string,
  options: ChatOptions = {}
): Promise<void> {
  const { limit = 5, threshold = 0.2, verbose = false } = options;

  if (verbose) {
    console.log(`Searching for context: "${query}"`);
    console.log(`Limit: ${limit}, Threshold: ${threshold}\n`);
  }

  // Get query embedding and search
  let context = '';
  try {
    const queryEmbedding = await getEmbedding(query);
    const results = await searchDocuments(queryEmbedding, limit, threshold);

    if (results.length > 0) {
      if (verbose) {
        console.log(`Found ${results.length} relevant chunks:\n`);
      }

      // Build context from search results
      const contextParts: string[] = [];
      for (const result of results) {
        const location = `${result.file_path}:${result.start_line}-${result.end_line}`;
        const similarity = (result.similarity * 100).toFixed(1);

        if (verbose) {
          console.log(`  ${location} (${similarity}%)`);
        }

        contextParts.push(`--- ${location} ---\n${result.content}`);
      }

      context = contextParts.join('\n\n');

      if (verbose) {
        console.log('\n---\n');
      }
    } else {
      if (verbose) {
        console.log('No relevant context found.\n');
      }
    }
  } catch (error) {
    logError('chat', 'Error searching:', error instanceof Error ? error : new Error(String(error)));

    console.error('Error searching:', error);
  } finally {
    closeDb();
  }

  // Build messages for chat
  // Note: This is CLI mode - no MCP tools available, only RAG context
  const userMessage = context
    ? `Here is relevant context from the project's knowledge base:

<context>
${context}
</context>

Based on this context, please answer the following question:

${query}`
    : query;

  const messages: ChatMessage[] = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  if (verbose) {
    console.log('Calling LLM...\n');
  }

  try {
    const response = await callLLMChat(messages, { timeout: 60000 });
    console.log(response);
  } catch (error) {
    console.error('Error calling LLM:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

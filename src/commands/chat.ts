import { searchDocuments, closeDb } from '../lib/db.js';
import { getEmbedding } from '../lib/embeddings.js';
import { callLLMChat, ChatMessage } from '../lib/llm.js';

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
    const results = searchDocuments(queryEmbedding, limit, threshold);

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
    console.error('Error searching:', error);
  } finally {
    closeDb();
  }

  // Build messages for chat
  // Note: This is CLI mode - no MCP tools available, only RAG context
  const systemPrompt = `You are a helpful assistant for succ — a persistent memory and knowledge base system for AI coding assistants.

## Important: CLI Mode

You are running via \`succ chat\` CLI command. You do NOT have access to MCP tools.
Context from the knowledge base has been pre-fetched and provided below.
Do NOT claim you can use succ_search, succ_recall, or other MCP tools — those only work in Claude Code.

## About succ

succ provides:
- **Brain Vault** (.succ/brain/) — Markdown docs indexed for semantic search
- **Memories** — Decisions, learnings, patterns that persist across sessions
- **Code Index** — Semantic search across source code

## CLI Commands (for users)

| Command | Purpose |
|---------|---------|
| succ search <query> | Search brain vault |
| succ recall <query> | Search memories |
| succ remember <text> | Store a memory |
| succ status | Show indexed docs, memories |
| succ index | Index brain vault documents |
| succ index-code | Index source code |
| succ analyze | Generate docs from code |

## Your Role

Answer questions using the provided context (if any).
If context doesn't help, give general guidance.
Be concise and practical.`;

  const userMessage = context
    ? `Here is relevant context from the project's knowledge base:

<context>
${context}
</context>

Based on this context, please answer the following question:

${query}`
    : query;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
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

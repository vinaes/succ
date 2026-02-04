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
  const systemPrompt = `You are a helpful assistant for succ — a persistent memory and knowledge base system for AI coding assistants like Claude Code.

## About succ

succ provides:
- **Brain Vault** (.succ/brain/) — Markdown docs indexed for semantic search
- **Memories** — Decisions, learnings, patterns that persist across Claude sessions
- **Code Index** — Semantic search across source code
- **MCP Tools** — Claude uses succ_search, succ_recall, succ_remember automatically

## Key Commands

| Command | Purpose |
|---------|---------|
| succ init | Initialize succ in a project |
| succ index | Index brain vault documents |
| succ index-code | Index source code |
| succ analyze | Generate docs from code analysis |
| succ search <query> | Search brain vault |
| succ remember <content> | Store a memory |
| succ recall <query> | Search memories |
| succ status | Show indexed docs, memories, daemon status |
| succ stats | Token savings statistics |
| succ daemon start | Start background services |

## MCP Tools (for Claude)

Claude automatically uses these via MCP:
- succ_search — search brain vault docs
- succ_recall — search memories
- succ_search_code — search source code
- succ_remember — store new memory
- succ_analyze_file — analyze a source file

## Configuration

Config files: ~/.succ/config.json (global), .succ/config.json (project)

Key settings:
- embedding_mode: local | openrouter | custom
- llm.backend: local | openrouter | claude
- chat_llm: separate config for interactive chat

## Your Role

Answer questions about this project using the provided context.
If asked about succ itself, use the knowledge above.
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

import { spawn } from 'child_process';
import { searchDocuments, closeDb } from '../lib/db.js';
import { getEmbedding } from '../lib/embeddings.js';

interface ChatOptions {
  limit?: number;
  threshold?: number;
  verbose?: boolean;
}

/**
 * RAG chat - search context + Claude CLI
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

  // Build prompt with context
  let prompt: string;
  if (context) {
    prompt = `Here is relevant context from the project's knowledge base:

<context>
${context}
</context>

Based on this context, please answer the following question:

${query}`;
  } else {
    prompt = query;
  }

  // Call Claude CLI
  if (verbose) {
    console.log('Calling Claude CLI...\n');
  }

  const claude = spawn('claude', ['-p', prompt, '--no-config'], {
    stdio: ['inherit', 'inherit', 'inherit'],
    shell: true,
  });

  claude.on('error', (error) => {
    console.error('Failed to start Claude CLI:', error.message);
    console.error('Make sure Claude CLI is installed: npm install -g @anthropic-ai/claude-code');
    process.exit(1);
  });

  claude.on('close', (code) => {
    process.exit(code ?? 0);
  });
}

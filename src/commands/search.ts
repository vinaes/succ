import { getEmbedding } from '../lib/embeddings.js';
import { searchDocuments, closeDb, getStoredEmbeddingDimension, clearDocuments } from '../lib/storage/index.js';
import { getConfig } from '../lib/config.js';
import inquirer from 'inquirer';
import { index as indexBrain } from './index.js';
import { logError } from '../lib/fault-logger.js';

interface SearchOptions {
  limit?: string;
  threshold?: string;
}

export async function search(
  query: string,
  options: SearchOptions = {}
): Promise<void> {
  const limit = parseInt(options.limit || '5', 10);
  const threshold = parseFloat(options.threshold || '0.5');

  console.log(`Searching for: "${query}"`);
  console.log(`Limit: ${limit}, Threshold: ${threshold}\n`);

  try {
    // Check for dimension mismatch before searching
    const storedDimension = await getStoredEmbeddingDimension();
    if (storedDimension !== null) {
      // Get a test embedding to check current dimension
      const testEmbedding = await getEmbedding('test');
      const currentDimension = testEmbedding.length;

      if (storedDimension !== currentDimension) {
        const config = getConfig();
        console.log(`\n⚠️  Embedding dimension mismatch detected!`);
        console.log(`   Stored embeddings: ${storedDimension} dimensions`);
        console.log(`   Current model (${config.embedding_model}): ${currentDimension} dimensions\n`);

        // In non-interactive mode (no TTY), auto-reindex
        const isInteractive = process.stdout.isTTY;

        let action: string;
        if (isInteractive) {
          const response = await inquirer.prompt([
            {
              type: 'list',
              name: 'action',
              message: 'What would you like to do?',
              choices: [
                { name: 'Reindex now (clear old index and reindex with current model)', value: 'reindex' },
                { name: 'Cancel search', value: 'cancel' },
              ],
            },
          ]);
          action = response.action;
        } else {
          // Non-interactive: auto-reindex
          console.log('Non-interactive mode: automatically clearing and reindexing...');
          action = 'reindex';
        }

        if (action === 'cancel') {
          console.log('Search cancelled.');
          return;
        }

        if (action === 'reindex') {
          console.log('\nClearing old index...');
          await clearDocuments();
          console.log('Reindexing with current model...\n');
          await indexBrain(undefined, { force: true, autoReindex: true });
          console.log('\n--- Continuing search ---\n');
        }
      }
    }

    // Get query embedding
    const queryEmbedding = await getEmbedding(query);

    // Search
    const results = await searchDocuments(queryEmbedding, limit, threshold);

    if (results.length === 0) {
      console.log('No results found above threshold.');
      return;
    }

    console.log(`Found ${results.length} results:\n`);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const similarity = (result.similarity * 100).toFixed(1);

      console.log(`${i + 1}. ${result.file_path}:${result.start_line}-${result.end_line}`);
      console.log(`   Similarity: ${similarity}%`);
      console.log(`   ${result.content.slice(0, 200).replace(/\n/g, ' ')}...`);
      console.log();
    }
  } catch (error) {
    logError('search', 'Search error:', error instanceof Error ? error : new Error(String(error)));

    console.error('Search error:', error);
    process.exit(1);
  } finally {
    closeDb();
  }
}

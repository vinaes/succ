import { getEmbedding } from '../lib/embeddings.js';
import { searchDocuments, closeDb } from '../lib/db.js';

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
    // Get query embedding
    const queryEmbedding = await getEmbedding(query);

    // Search
    const results = searchDocuments(queryEmbedding, limit, threshold);

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
    console.error('Search error:', error);
    process.exit(1);
  } finally {
    closeDb();
  }
}

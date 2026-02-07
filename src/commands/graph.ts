import {
  closeDb,
  getGraphStats,
  autoLinkSimilarMemories,
} from '../lib/storage/index.js';
import { exportGraphSilent } from '../lib/graph-export.js';

interface GraphOptions {
  action: 'export' | 'stats' | 'auto-link';
  format?: 'obsidian' | 'json';
  threshold?: number;
  output?: string;
}

/**
 * Knowledge graph management command
 */
export async function graph(options: GraphOptions): Promise<void> {
  try {
    switch (options.action) {
      case 'export':
        await exportGraph(options.format || 'obsidian', options.output);
        break;
      case 'stats':
        await showStats();
        break;
      case 'auto-link':
        await autoLink(options.threshold || 0.75);
        break;
    }
  } finally {
    closeDb();
  }
}

/**
 * Export graph to Obsidian-compatible markdown
 */
async function exportGraph(format: 'obsidian' | 'json', outputDir?: string): Promise<void> {
  const result = await exportGraphSilent(format, outputDir);

  if (result.memoriesExported === 0) {
    console.log('No memories to export.');
    return;
  }

  console.log(`Exported ${result.memoriesExported} memories and ${result.linksExported} links.`);
  if (format === 'obsidian') {
    console.log('Open the graph folder in Obsidian to visualize the knowledge graph.');
  }
}

async function showStats(): Promise<void> {
  const stats = await getGraphStats();

  console.log('\nKnowledge Graph Statistics\n');
  console.log(`  Memories:         ${stats.total_memories}`);
  console.log(`  Links:            ${stats.total_links}`);
  console.log(`  Avg links/memory: ${stats.avg_links_per_memory.toFixed(2)}`);
  console.log(`  Isolated:         ${stats.isolated_memories}`);

  if (Object.keys(stats.relations).length > 0) {
    console.log('\n  By relation:');
    for (const [relation, count] of Object.entries(stats.relations)) {
      console.log(`    ${relation}: ${count}`);
    }
  }
  console.log('');
}

async function autoLink(threshold: number): Promise<void> {
  console.log(`Auto-linking similar memories (threshold: ${threshold})...`);
  const created = await autoLinkSimilarMemories(threshold, 3);
  console.log(`Created ${created} new links.`);
}

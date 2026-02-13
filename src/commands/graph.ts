import { closeDb, getGraphStats, autoLinkSimilarMemories } from '../lib/storage/index.js';
import { exportGraphSilent } from '../lib/graph-export.js';

interface GraphOptions {
  action:
    | 'export'
    | 'stats'
    | 'auto-link'
    | 'enrich-relations'
    | 'proximity'
    | 'communities'
    | 'centrality';
  format?: 'obsidian' | 'json';
  threshold?: number;
  output?: string;
  force?: boolean;
  limit?: number;
  dryRun?: boolean;
  minCount?: number;
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
      case 'enrich-relations':
        await enrichRelations(options.force, options.limit);
        break;
      case 'proximity':
        await proximity(options.minCount, options.dryRun);
        break;
      case 'communities':
        await communities();
        break;
      case 'centrality':
        await centrality();
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

async function enrichRelations(force?: boolean, limit?: number): Promise<void> {
  const { enrichExistingLinks } = await import('../lib/graph/llm-relations.js');
  console.log('Enriching link relations via LLM...');
  const result = await enrichExistingLinks({ force, limit });
  console.log(`Enriched: ${result.enriched}, Failed: ${result.failed}, Skipped: ${result.skipped}`);
}

async function proximity(minCount?: number, dryRun?: boolean): Promise<void> {
  const { createProximityLinks } = await import('../lib/graph/contextual-proximity.js');
  console.log('Creating contextual proximity links...');
  const result = await createProximityLinks({ minCooccurrence: minCount ?? 2, dryRun });
  if (dryRun) {
    console.log(`Dry run: ${result.total_pairs} pairs found (minCooccurrence: ${minCount ?? 2}).`);
  } else {
    console.log(
      `Created: ${result.created}, Skipped: ${result.skipped}, Total pairs: ${result.total_pairs}`
    );
  }
}

async function communities(): Promise<void> {
  const { detectCommunities } = await import('../lib/graph/community-detection.js');
  console.log('Running community detection...');
  const result = await detectCommunities();
  console.log(
    `Detected ${result.communities.length} communities, ${result.isolated} isolated nodes.`
  );
  for (const c of result.communities) {
    console.log(
      `  Community ${c.id}: ${c.size} members [${c.members.slice(0, 10).join(', ')}${c.size > 10 ? '...' : ''}]`
    );
  }
}

async function centrality(): Promise<void> {
  const { updateCentralityCache } = await import('../lib/graph/centrality.js');
  console.log('Computing centrality scores...');
  const result = await updateCentralityCache();
  console.log(`Updated centrality for ${result.updated} memories.`);
}

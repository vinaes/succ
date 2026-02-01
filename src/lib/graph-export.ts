import fs from 'fs';
import path from 'path';
import { getClaudeDir, getConfig, getProjectRoot } from './config.js';
import {
  getDb,
  getMemoryLinks,
  getGraphStats,
  type MemoryType,
} from './db.js';

/**
 * Map memory type to brain vault folder
 */
function getTargetFolder(type: MemoryType | string, tags: string[], brainDir: string): string {
  const projectName = path.basename(getProjectRoot());

  // Decision memories go to project Decisions folder
  if (type === 'decision' || tags.includes('decision')) {
    return path.join(brainDir, '01_Projects', projectName, 'Decisions');
  }

  // Learning and pattern memories go to Knowledge
  if (type === 'learning' || type === 'pattern' || tags.includes('learning') || tags.includes('pattern')) {
    return path.join(brainDir, '02_Knowledge');
  }

  // Error memories go to Inbox for quick review
  if (type === 'error' || tags.includes('error') || tags.includes('bug')) {
    return path.join(brainDir, '00_Inbox');
  }

  // Observations and everything else go to Inbox
  return path.join(brainDir, '00_Inbox');
}

/**
 * Get relative path for wiki-link based on target type
 */
function getWikiLinkPath(
  targetType: MemoryType | string,
  targetTags: string[],
  targetId: number,
  dateStr: string
): string {
  const projectName = path.basename(getProjectRoot());

  if (targetType === 'decision' || targetTags.includes('decision')) {
    return `01_Projects/${projectName}/Decisions/${dateStr}-${targetType}-${targetId}`;
  }
  if (targetType === 'learning' || targetType === 'pattern' || targetTags.includes('learning') || targetTags.includes('pattern')) {
    return `02_Knowledge/${dateStr}-${targetType}-${targetId}`;
  }
  return `00_Inbox/${dateStr}-${targetType}-${targetId}`;
}

// Debounce state for auto-export
let exportTimer: ReturnType<typeof setTimeout> | null = null;
let lastExportTime = 0;
const EXPORT_DEBOUNCE_MS = 5000; // Wait 5 seconds after last change before exporting

/**
 * Schedule an auto-export if enabled in config
 * Debounced to avoid excessive exports during bulk operations
 */
export function scheduleAutoExport(): void {
  const config = getConfig();

  if (!config.graph_auto_export) {
    return;
  }

  // Clear existing timer
  if (exportTimer) {
    clearTimeout(exportTimer);
  }

  // Schedule export after debounce period
  exportTimer = setTimeout(() => {
    exportTimer = null;
    const now = Date.now();

    // Additional check: don't export more than once per 5 seconds
    if (now - lastExportTime < EXPORT_DEBOUNCE_MS) {
      return;
    }

    lastExportTime = now;

    try {
      exportGraphSilent(
        config.graph_export_format || 'obsidian',
        config.graph_export_path
      );
    } catch {
      // Silently ignore export errors in auto-export
    }
  }, EXPORT_DEBOUNCE_MS);
}

/**
 * Export graph silently (no console output) - for auto-export
 */
export function exportGraphSilent(
  format: 'obsidian' | 'json' = 'obsidian',
  outputDir?: string
): { memoriesExported: number; linksExported: number } {
  const database = getDb();

  // Get all memories
  const memories = database
    .prepare(`
      SELECT id, content, tags, source, type, created_at
      FROM memories
      ORDER BY created_at DESC
    `)
    .all() as Array<{
      id: number;
      content: string;
      tags: string | null;
      source: string | null;
      type: string | null;
      created_at: string;
    }>;

  if (memories.length === 0) {
    return { memoriesExported: 0, linksExported: 0 };
  }

  // Determine output directory - export directly to brain folder
  const claudeDir = getClaudeDir();
  const graphDir = outputDir || path.join(claudeDir, 'brain');

  // Create directory if needed
  if (!fs.existsSync(graphDir)) {
    fs.mkdirSync(graphDir, { recursive: true });
  }

  if (format === 'json') {
    return exportToJson(memories, graphDir, database);
  }

  return exportToObsidian(memories, graphDir, database);
}

function exportToJson(
  memories: Array<{
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    type: string | null;
    created_at: string;
  }>,
  graphDir: string,
  database: ReturnType<typeof getDb>
): { memoriesExported: number; linksExported: number } {
  const graphData = {
    memories: memories.map(m => ({
      id: m.id,
      content: m.content,
      tags: m.tags ? JSON.parse(m.tags) : [],
      source: m.source,
      type: m.type || 'observation',
      created_at: m.created_at,
    })),
    links: [] as Array<{ source: number; target: number; relation: string; weight: number }>,
    stats: getGraphStats(),
    exported_at: new Date().toISOString(),
  };

  // Get all links
  const links = database
    .prepare('SELECT source_id, target_id, relation, weight FROM memory_links')
    .all() as Array<{ source_id: number; target_id: number; relation: string; weight: number }>;

  graphData.links = links.map(l => ({
    source: l.source_id,
    target: l.target_id,
    relation: l.relation,
    weight: l.weight,
  }));

  const jsonPath = path.join(graphDir, 'memories-graph.json');
  fs.writeFileSync(jsonPath, JSON.stringify(graphData, null, 2));

  return { memoriesExported: memories.length, linksExported: links.length };
}

function exportToObsidian(
  memories: Array<{
    id: number;
    content: string;
    tags: string | null;
    source: string | null;
    type: string | null;
    created_at: string;
  }>,
  brainDir: string,
  database: ReturnType<typeof getDb>
): { memoriesExported: number; linksExported: number } {
  let exported = 0;
  let totalLinks = 0;

  // Build maps for link resolution
  const memoryTagsMap = new Map<number, string[]>();
  const memoryDatesMap = new Map<number, string>();
  for (const m of memories) {
    memoryTagsMap.set(m.id, m.tags ? JSON.parse(m.tags) : []);
    memoryDatesMap.set(m.id, new Date(m.created_at).toISOString().split('T')[0]);
  }

  for (const memory of memories) {
    const tags: string[] = memory.tags ? JSON.parse(memory.tags) : [];
    const links = getMemoryLinks(memory.id);
    totalLinks += links.outgoing.length;

    // Determine target folder based on type/tags
    const type = memory.type || 'observation';
    const targetDir = getTargetFolder(type, tags, brainDir);

    // Create directory if needed
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Generate filename with date prefix for better sorting
    const date = new Date(memory.created_at);
    const dateStr = date.toISOString().split('T')[0];
    const safeId = `${dateStr}-${type}-${memory.id}`;
    const filename = `${safeId}.md`;

    // Generate title from content (first line or truncated)
    const firstLine = memory.content.split('\n')[0].trim();
    const title = firstLine.length > 60 ? firstLine.substring(0, 57) + '...' : firstLine;

    // Build content
    let content = `---
id: ${memory.id}
type: ${type}
tags: [${tags.map(t => `"${t}"`).join(', ')}]
source: ${memory.source || 'unknown'}
created: ${memory.created_at}
---

# ${title}

${memory.content}

`;

    // Add outgoing links as Obsidian wiki-links
    if (links.outgoing.length > 0) {
      content += `## Related\n\n`;
      for (const link of links.outgoing) {
        const targetType = getMemoryType(link.target_id, database);
        const targetTags = memoryTagsMap.get(link.target_id) || [];
        const targetDate = memoryDatesMap.get(link.target_id) || dateStr;
        const wikiPath = getWikiLinkPath(targetType, targetTags, link.target_id, targetDate);
        content += `- [[${wikiPath}]] (${link.relation})\n`;
      }
      content += '\n';
    }

    // Add incoming links
    if (links.incoming.length > 0) {
      content += `## Referenced By\n\n`;
      for (const link of links.incoming) {
        const sourceType = getMemoryType(link.source_id, database);
        const sourceTags = memoryTagsMap.get(link.source_id) || [];
        const sourceDate = memoryDatesMap.get(link.source_id) || dateStr;
        const wikiPath = getWikiLinkPath(sourceType, sourceTags, link.source_id, sourceDate);
        content += `- [[${wikiPath}]] (${link.relation})\n`;
      }
      content += '\n';
    }

    // Write file
    const filePath = path.join(targetDir, filename);
    fs.writeFileSync(filePath, content);
    exported++;
  }

  // Create index file in brain root
  const indexContent = generateIndexContent(memories, brainDir, database);
  fs.writeFileSync(path.join(brainDir, 'memories-index.md'), indexContent);

  return { memoriesExported: exported, linksExported: totalLinks };
}

function getMemoryType(id: number, database: ReturnType<typeof getDb>): string {
  const row = database
    .prepare('SELECT type FROM memories WHERE id = ?')
    .get(id) as { type: string | null } | undefined;
  return row?.type || 'observation';
}

function generateIndexContent(
  memories: Array<{ id: number; content: string; type: string | null; tags: string | null; created_at: string }>,
  brainDir: string,
  database: ReturnType<typeof getDb>
): string {
  const stats = getGraphStats();
  const projectName = path.basename(getProjectRoot());

  // Group by location
  const byLocation: Record<string, Array<{ id: number; type: string; date: string }>> = {
    'Decisions': [],
    'Knowledge': [],
    'Inbox': [],
  };

  for (const m of memories) {
    const type = m.type || 'observation';
    const tags: string[] = m.tags ? JSON.parse(m.tags) : [];
    const dateStr = new Date(m.created_at).toISOString().split('T')[0];

    if (type === 'decision' || tags.includes('decision')) {
      byLocation['Decisions'].push({ id: m.id, type, date: dateStr });
    } else if (type === 'learning' || type === 'pattern' || tags.includes('learning') || tags.includes('pattern')) {
      byLocation['Knowledge'].push({ id: m.id, type, date: dateStr });
    } else {
      byLocation['Inbox'].push({ id: m.id, type, date: dateStr });
    }
  }

  let content = `# Memory Index

## Statistics

- **Total Memories:** ${stats.total_memories}
- **Total Links:** ${stats.total_links}
- **Avg Links/Memory:** ${stats.avg_links_per_memory.toFixed(2)}
- **Isolated Memories:** ${stats.isolated_memories}

## By Location

`;

  // Decisions
  if (byLocation['Decisions'].length > 0) {
    content += `### 📋 Decisions (${byLocation['Decisions'].length})\n\n`;
    content += `Located in: \`01_Projects/${projectName}/Decisions/\`\n\n`;
    for (const { id, type, date } of byLocation['Decisions'].slice(0, 10)) {
      content += `- [[01_Projects/${projectName}/Decisions/${date}-${type}-${id}]]\n`;
    }
    if (byLocation['Decisions'].length > 10) {
      content += `- ... and ${byLocation['Decisions'].length - 10} more\n`;
    }
    content += '\n';
  }

  // Knowledge
  if (byLocation['Knowledge'].length > 0) {
    content += `### 📚 Knowledge (${byLocation['Knowledge'].length})\n\n`;
    content += `Located in: \`02_Knowledge/\`\n\n`;
    for (const { id, type, date } of byLocation['Knowledge'].slice(0, 10)) {
      content += `- [[02_Knowledge/${date}-${type}-${id}]]\n`;
    }
    if (byLocation['Knowledge'].length > 10) {
      content += `- ... and ${byLocation['Knowledge'].length - 10} more\n`;
    }
    content += '\n';
  }

  // Inbox
  if (byLocation['Inbox'].length > 0) {
    content += `### 📥 Inbox (${byLocation['Inbox'].length})\n\n`;
    content += `Located in: \`00_Inbox/\`\n\n`;
    for (const { id, type, date } of byLocation['Inbox'].slice(0, 10)) {
      content += `- [[00_Inbox/${date}-${type}-${id}]]\n`;
    }
    if (byLocation['Inbox'].length > 10) {
      content += `- ... and ${byLocation['Inbox'].length - 10} more\n`;
    }
    content += '\n';
  }

  content += `## Links by Relation

`;

  for (const [relation, count] of Object.entries(stats.relations)) {
    content += `- **${relation}:** ${count}\n`;
  }

  content += `
---
*Generated: ${new Date().toLocaleString()}*
`;

  return content;
}

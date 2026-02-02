import fs from 'fs';
import path from 'path';
import { getClaudeDir, getConfig, getProjectRoot } from './config.js';
import {
  getDb,
  getMemoryLinks,
  getGraphStats,
  type MemoryType,
} from './db.js';
import { calculateTemporalScore, getTemporalConfig } from './temporal.js';

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

  // Get all memories with temporal fields
  const memories = database
    .prepare(`
      SELECT id, content, tags, source, type, created_at,
             valid_from, valid_until, last_accessed, access_count
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
      valid_from: string | null;
      valid_until: string | null;
      last_accessed: string | null;
      access_count: number;
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
    valid_from?: string | null;
    valid_until?: string | null;
    last_accessed?: string | null;
    access_count?: number;
  }>,
  graphDir: string,
  database: ReturnType<typeof getDb>
): { memoriesExported: number; linksExported: number } {
  const temporalConfig = getTemporalConfig();
  const now = new Date();

  const graphData = {
    memories: memories.map(m => {
      const temporalResult = calculateTemporalScore(1.0, {
        created_at: m.created_at,
        last_accessed: m.last_accessed || null,
        access_count: m.access_count || 0,
        valid_from: m.valid_from || null,
        valid_until: m.valid_until || null,
      }, temporalConfig);
      const temporalScore = temporalResult.temporalScore;

      // Determine temporal status
      let temporalStatus = 'active';
      if (m.valid_until && new Date(m.valid_until) < now) {
        temporalStatus = 'expired';
      } else if (m.valid_from && new Date(m.valid_from) > now) {
        temporalStatus = 'future';
      } else if (temporalScore < 0.3) {
        temporalStatus = 'fading';
      }

      return {
        id: m.id,
        content: m.content,
        tags: m.tags ? JSON.parse(m.tags) : [],
        source: m.source,
        type: m.type || 'observation',
        created_at: m.created_at,
        // Temporal fields
        valid_from: m.valid_from,
        valid_until: m.valid_until,
        last_accessed: m.last_accessed,
        access_count: m.access_count || 0,
        temporal_status: temporalStatus,
        decay_score: parseFloat(temporalScore.toFixed(2)),
      };
    }),
    links: [] as Array<{ source: number; target: number; relation: string; weight: number }>,
    stats: getGraphStats(),
    temporal_summary: {
      active: 0,
      expired: 0,
      future: 0,
      fading: 0,
    },
    exported_at: new Date().toISOString(),
  };

  // Count temporal statuses
  for (const m of graphData.memories) {
    graphData.temporal_summary[m.temporal_status as keyof typeof graphData.temporal_summary]++;
  }

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
    valid_from?: string | null;
    valid_until?: string | null;
    last_accessed?: string | null;
    access_count?: number;
  }>,
  brainDir: string,
  database: ReturnType<typeof getDb>
): { memoriesExported: number; linksExported: number } {
  let exported = 0;
  let totalLinks = 0;

  // Get temporal config for decay calculation
  const temporalConfig = getTemporalConfig();
  const now = new Date();

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

    // Calculate temporal state and decay score
    const temporalResult = calculateTemporalScore(1.0, {
      created_at: memory.created_at,
      last_accessed: memory.last_accessed || null,
      access_count: memory.access_count || 0,
      valid_from: memory.valid_from || null,
      valid_until: memory.valid_until || null,
    }, temporalConfig);
    const temporalScore = temporalResult.temporalScore;

    // Determine temporal status
    let temporalStatus = 'active';
    let statusEmoji = '🟢';
    if (memory.valid_until && new Date(memory.valid_until) < now) {
      temporalStatus = 'expired';
      statusEmoji = '⚫';
    } else if (memory.valid_from && new Date(memory.valid_from) > now) {
      temporalStatus = 'future';
      statusEmoji = '🔵';
    } else if (temporalScore < 0.3) {
      temporalStatus = 'fading';
      statusEmoji = '🟡';
    }

    // Build frontmatter with temporal metadata
    const frontmatterLines = [
      '---',
      `id: ${memory.id}`,
      `type: ${type}`,
      `tags: [${tags.map(t => `"${t}"`).join(', ')}]`,
      `source: ${memory.source || 'unknown'}`,
      `created: ${memory.created_at}`,
    ];

    // Add temporal fields if present
    if (memory.valid_from) {
      frontmatterLines.push(`valid_from: ${memory.valid_from}`);
    }
    if (memory.valid_until) {
      frontmatterLines.push(`valid_until: ${memory.valid_until}`);
    }

    // Add computed temporal metadata
    frontmatterLines.push(`temporal_status: ${temporalStatus}`);
    frontmatterLines.push(`decay_score: ${temporalScore.toFixed(2)}`);
    if (memory.access_count && memory.access_count > 0) {
      frontmatterLines.push(`access_count: ${memory.access_count}`);
    }
    if (memory.last_accessed) {
      frontmatterLines.push(`last_accessed: ${memory.last_accessed}`);
    }

    frontmatterLines.push('---');

    // Build content with status indicator in title
    let content = `${frontmatterLines.join('\n')}

# ${statusEmoji} ${title}

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

  // Create index file in brain root (Memories.md - no kebab-case)
  const indexContent = generateIndexContent(memories, brainDir, database);
  fs.writeFileSync(path.join(brainDir, 'Memories.md'), indexContent);

  // Create/update Obsidian config for graph colors
  ensureObsidianGraphConfig(brainDir);

  return { memoriesExported: exported, linksExported: totalLinks };
}

/**
 * Ensure Obsidian graph config exists with color groups for folders and tags
 */
function ensureObsidianGraphConfig(brainDir: string): void {
  const obsidianDir = path.join(brainDir, '.obsidian');
  const snippetsDir = path.join(obsidianDir, 'snippets');

  // Create directories if needed
  if (!fs.existsSync(obsidianDir)) {
    fs.mkdirSync(obsidianDir, { recursive: true });
  }
  if (!fs.existsSync(snippetsDir)) {
    fs.mkdirSync(snippetsDir, { recursive: true });
  }

  // Graph config with color groups
  const graphConfig = {
    "collapse-filter": false,
    "search": "",
    "showTags": true,
    "showAttachments": false,
    "hideUnresolved": false,
    "showOrphans": true,
    "collapse-color-groups": false,
    "colorGroups": [
      // Folders
      { "query": "path:Decisions", "color": { "a": 1, "rgb": 16744448 } },    // Orange
      { "query": "path:Strategy", "color": { "a": 1, "rgb": 10494192 } },     // Purple
      { "query": "path:02_Knowledge", "color": { "a": 1, "rgb": 65382 } },    // Green
      { "query": "path:Systems", "color": { "a": 1, "rgb": 3447003 } },       // Cyan
      { "query": "path:Features", "color": { "a": 1, "rgb": 16761035 } },     // Pink
      { "query": "path:Technical", "color": { "a": 1, "rgb": 10066329 } },    // Silver
      { "query": "path:Files", "color": { "a": 1, "rgb": 6591981 } },         // Teal
      { "query": "path:Reflections", "color": { "a": 1, "rgb": 9109504 } },   // Dark red
      { "query": "path:00_Inbox", "color": { "a": 1, "rgb": 8421504 } },      // Gray
      // Tags (higher priority - listed after folders)
      { "query": "tag:#decision", "color": { "a": 1, "rgb": 16744448 } },     // Orange
      { "query": "tag:#learning", "color": { "a": 1, "rgb": 65382 } },        // Green
      { "query": "tag:#pattern", "color": { "a": 1, "rgb": 10494192 } },      // Purple
      { "query": "tag:#error", "color": { "a": 1, "rgb": 16711680 } },        // Red
      { "query": "tag:#architecture", "color": { "a": 1, "rgb": 3447003 } },  // Cyan
      { "query": "tag:#sprint", "color": { "a": 1, "rgb": 65535 } },          // Aqua
    ],
    "collapse-display": false,
    "showArrow": true,
    "textFadeMultiplier": 0,
    "nodeSizeMultiplier": 1.2,
    "lineSizeMultiplier": 1,
    "collapse-forces": false,
    "centerStrength": 0.5,
    "repelStrength": 12,
    "linkStrength": 1,
    "linkDistance": 180,
    "scale": 0.6,
    "close": false
  };

  // Write graph config
  fs.writeFileSync(
    path.join(obsidianDir, 'graph.json'),
    JSON.stringify(graphConfig, null, 2)
  );

  // CSS snippet for additional styling
  const cssSnippet = `/* succ Brain Vault Graph Styling - Auto-generated */

/* Tag colors in editor */
.tag[href="#decision"] { background-color: rgba(255,149,0,0.2); color: #FF9500; }
.tag[href="#learning"] { background-color: rgba(0,255,102,0.2); color: #00FF66; }
.tag[href="#pattern"] { background-color: rgba(160,32,240,0.2); color: #A020F0; }
.tag[href="#error"] { background-color: rgba(255,0,0,0.2); color: #FF0000; }
.tag[href="#sprint"] { background-color: rgba(0,255,255,0.2); color: #00FFFF; }
.tag[href="#architecture"] { background-color: rgba(52,152,219,0.2); color: #3498DB; }

/* Temporal status indicators in titles */
.markdown-preview-view h1 { position: relative; }

/* Graph link visibility */
.graph-view .links line { stroke-opacity: 0.6; stroke-width: 1.5px; }
.graph-view .nodes circle:hover { stroke: #fff; stroke-width: 2px; }

/* Frontmatter styling */
.metadata-property[data-property-key="temporal_status"] .metadata-property-value { font-weight: bold; }
.metadata-property[data-property-key="decay_score"] .metadata-property-value { font-family: monospace; }
`;

  fs.writeFileSync(path.join(snippetsDir, 'succ-graph.css'), cssSnippet);

  // Enable the snippet in appearance.json
  const appearanceConfig = {
    "cssTheme": "",
    "enabledCssSnippets": ["succ-graph"]
  };
  fs.writeFileSync(
    path.join(obsidianDir, 'appearance.json'),
    JSON.stringify(appearanceConfig, null, 2)
  );
}

function getMemoryType(id: number, database: ReturnType<typeof getDb>): string {
  const row = database
    .prepare('SELECT type FROM memories WHERE id = ?')
    .get(id) as { type: string | null } | undefined;
  return row?.type || 'observation';
}

function generateIndexContent(
  memories: Array<{
    id: number;
    content: string;
    type: string | null;
    tags: string | null;
    created_at: string;
    valid_from?: string | null;
    valid_until?: string | null;
    last_accessed?: string | null;
    access_count?: number;
  }>,
  brainDir: string,
  database: ReturnType<typeof getDb>
): string {
  const stats = getGraphStats();
  const projectName = path.basename(getProjectRoot());
  const temporalConfig = getTemporalConfig();
  const now = new Date();

  // Track temporal statistics
  const temporalStats = {
    active: 0,
    expired: 0,
    future: 0,
    fading: 0,
  };

  // Group by location
  const byLocation: Record<string, Array<{ id: number; type: string; date: string; status: string }>> = {
    'Decisions': [],
    'Knowledge': [],
    'Inbox': [],
  };

  for (const m of memories) {
    const type = m.type || 'observation';
    const tags: string[] = m.tags ? JSON.parse(m.tags) : [];
    const dateStr = new Date(m.created_at).toISOString().split('T')[0];

    // Calculate temporal status
    const temporalResult = calculateTemporalScore(1.0, {
      created_at: m.created_at,
      last_accessed: m.last_accessed || null,
      access_count: m.access_count || 0,
      valid_from: m.valid_from || null,
      valid_until: m.valid_until || null,
    }, temporalConfig);
    const temporalScore = temporalResult.temporalScore;

    let status = 'active';
    if (m.valid_until && new Date(m.valid_until) < now) {
      status = 'expired';
    } else if (m.valid_from && new Date(m.valid_from) > now) {
      status = 'future';
    } else if (temporalScore < 0.3) {
      status = 'fading';
    }
    temporalStats[status as keyof typeof temporalStats]++;

    if (type === 'decision' || tags.includes('decision')) {
      byLocation['Decisions'].push({ id: m.id, type, date: dateStr, status });
    } else if (type === 'learning' || type === 'pattern' || tags.includes('learning') || tags.includes('pattern')) {
      byLocation['Knowledge'].push({ id: m.id, type, date: dateStr, status });
    } else {
      byLocation['Inbox'].push({ id: m.id, type, date: dateStr, status });
    }
  }

  let content = `# Memories

## Statistics

- **Total Memories:** ${stats.total_memories}
- **Total Links:** ${stats.total_links}
- **Avg Links/Memory:** ${stats.avg_links_per_memory.toFixed(2)}
- **Isolated Memories:** ${stats.isolated_memories}

## Temporal Status

| Status | Count | Description |
|--------|-------|-------------|
| 🟢 Active | ${temporalStats.active} | Currently valid memories |
| 🟡 Fading | ${temporalStats.fading} | Low relevance (decay < 30%) |
| 🔵 Future | ${temporalStats.future} | Not yet valid (scheduled) |
| ⚫ Expired | ${temporalStats.expired} | Past validity period |

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

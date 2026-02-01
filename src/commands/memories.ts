import {
  getRecentMemories,
  searchMemories,
  saveMemory,
  closeDb,
  getMemoryStats,
  deleteMemory,
  deleteMemoriesOlderThan,
  deleteMemoriesByTag,
  getMemoryById,
  // Global memory functions
  saveGlobalMemory,
  searchGlobalMemories,
  getRecentGlobalMemories,
  deleteGlobalMemory,
  getGlobalMemoryStats,
  closeGlobalDb,
} from '../lib/db.js';
import { getEmbedding } from '../lib/embeddings.js';
import { getConfig, getProjectRoot } from '../lib/config.js';
import { scoreMemory, passesQualityThreshold, formatQualityScore } from '../lib/quality.js';
import path from 'path';

/**
 * Format quality score briefly for list display
 */
function formatQualityBrief(score: number): string {
  const percent = Math.round(score * 100);
  const stars = Math.round(score * 5);
  return `${'★'.repeat(stars)}${'☆'.repeat(5 - stars)} ${percent}%`;
}

interface MemoriesOptions {
  recent?: number;
  search?: string;
  tags?: string;
  limit?: number;
  global?: boolean;
  json?: boolean;
}

/**
 * List and manage memories
 */
export async function memories(options: MemoriesOptions = {}): Promise<void> {
  const { recent, search, tags, limit = 10, global: useGlobal, json: outputJson } = options;

  try {
    // Show recent memories
    if (recent !== undefined || (!search && !tags)) {
      const count = recent || limit;

      if (useGlobal) {
        // Global only
        const globalMemories = getRecentGlobalMemories(count);
        closeGlobalDb();

        if (globalMemories.length === 0) {
          if (outputJson) {
            console.log('[]');
          } else {
            console.log('No global memories stored yet.');
            console.log('\nUse `succ remember --global <content>` to add global memories.');
          }
          return;
        }

        if (outputJson) {
          console.log(JSON.stringify(globalMemories, null, 2));
          return;
        }

        console.log(`Recent global memories (${globalMemories.length}):\n`);

        for (const memory of globalMemories) {
          const date = new Date(memory.created_at).toLocaleDateString();
          const tagStr = memory.tags.length > 0 ? ` [${memory.tags.join(', ')}]` : '';
          const projectStr = memory.project ? ` (project: ${memory.project})` : '';

          console.log(`• [GLOBAL] ${date}${tagStr}${projectStr}`);
          console.log(`  ${memory.content.substring(0, 200)}${memory.content.length > 200 ? '...' : ''}`);
          console.log();
        }
        return;
      }

      // Local memories
      const recentMemories = getRecentMemories(count);
      closeDb();

      if (recentMemories.length === 0) {
        if (outputJson) {
          console.log('[]');
        } else {
          console.log('No memories stored yet.');
          console.log('\nUse succ_remember MCP tool or `succ remember <content>` to add memories.');
        }
        return;
      }

      if (outputJson) {
        console.log(JSON.stringify(recentMemories, null, 2));
        return;
      }

      console.log(`Recent memories (${recentMemories.length}):\n`);

      for (const memory of recentMemories) {
        const date = new Date(memory.created_at).toLocaleDateString();
        const tagStr = memory.tags.length > 0 ? ` [${memory.tags.join(', ')}]` : '';
        const sourceStr = memory.source ? ` (from: ${memory.source})` : '';
        const qualityStr = memory.quality_score !== null
          ? ` ${formatQualityBrief(memory.quality_score)}`
          : '';

        console.log(`• ${date}${tagStr}${sourceStr}${qualityStr}`);
        console.log(`  ${memory.content.substring(0, 200)}${memory.content.length > 200 ? '...' : ''}`);
        console.log();
      }
      return;
    }

    // Search memories
    if (search) {
      const queryEmbedding = await getEmbedding(search);
      const tagList = tags ? tags.split(',').map((t) => t.trim()) : undefined;

      if (useGlobal) {
        // Global only
        const results = searchGlobalMemories(queryEmbedding, limit, 0.3, tagList);
        closeGlobalDb();

        if (results.length === 0) {
          console.log(`No global memories found matching "${search}"`);
          return;
        }

        console.log(`Found ${results.length} global memories matching "${search}":\n`);

        for (const memory of results) {
          const date = new Date(memory.created_at).toLocaleDateString();
          const similarity = (memory.similarity * 100).toFixed(0);
          const tagStr = memory.tags.length > 0 ? ` [${memory.tags.join(', ')}]` : '';
          const projectStr = memory.project ? ` (project: ${memory.project})` : '';

          console.log(`• [GLOBAL] ${date}${tagStr}${projectStr} (${similarity}% match)`);
          console.log(`  ${memory.content.substring(0, 200)}${memory.content.length > 200 ? '...' : ''}`);
          console.log();
        }
        return;
      }

      // Local memories
      const results = searchMemories(queryEmbedding, limit, 0.3, tagList);
      closeDb();

      if (results.length === 0) {
        console.log(`No memories found matching "${search}"`);
        return;
      }

      console.log(`Found ${results.length} memories matching "${search}":\n`);

      for (const memory of results) {
        const date = new Date(memory.created_at).toLocaleDateString();
        const similarity = (memory.similarity * 100).toFixed(0);
        const tagStr = memory.tags.length > 0 ? ` [${memory.tags.join(', ')}]` : '';
        const qualityStr = memory.quality_score !== null
          ? ` ${formatQualityBrief(memory.quality_score)}`
          : '';

        console.log(`• ${date}${tagStr} (${similarity}% match)${qualityStr}`);
        console.log(`  ${memory.content.substring(0, 200)}${memory.content.length > 200 ? '...' : ''}`);
        console.log();
      }
    }
  } catch (error: any) {
    console.error('Error:', error.message);
    closeDb();
    closeGlobalDb();
    process.exit(1);
  }
}

interface RememberOptions {
  tags?: string;
  source?: string;
  global?: boolean;
  skipQuality?: boolean;
}

/**
 * Save a new memory from CLI
 */
export async function remember(content: string, options: RememberOptions = {}): Promise<void> {
  const { tags, source, global: useGlobal, skipQuality } = options;

  try {
    const tagList = tags ? tags.split(',').map((t) => t.trim()) : [];
    const embedding = await getEmbedding(content);

    // Score the memory quality (unless disabled)
    const config = getConfig();
    let qualityScore = null;
    if (!skipQuality && config.quality_scoring_enabled !== false) {
      qualityScore = await scoreMemory(content);

      // Check if it passes the threshold
      if (!passesQualityThreshold(qualityScore)) {
        console.log(`⚠ Memory quality too low: ${formatQualityScore(qualityScore)}`);
        console.log(`  Threshold: ${((config.quality_scoring_threshold ?? 0) * 100).toFixed(0)}%`);
        console.log(`  Use --skip-quality to bypass or lower the threshold in config.`);
        closeDb();
        closeGlobalDb();
        return;
      }
    }

    if (useGlobal) {
      // Save to global memory with project name
      const projectName = path.basename(getProjectRoot());
      const result = saveGlobalMemory(content, embedding, tagList, source, projectName);
      closeGlobalDb();

      const tagStr = tagList.length > 0 ? ` [${tagList.join(', ')}]` : '';
      const qualityStr = qualityScore ? ` ${formatQualityScore(qualityScore)}` : '';
      if (result.isDuplicate) {
        console.log(`⚠ Similar global memory exists (id: ${result.id}, ${((result.similarity || 0) * 100).toFixed(0)}% similar)`);
        console.log(`  Skipped duplicate.`);
      } else {
        console.log(`✓ Remembered globally (id: ${result.id})${tagStr}${qualityStr}`);
        console.log(`  Project: ${projectName}`);
        console.log(`  "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`);
      }
    } else {
      // Save to local memory with quality score
      const result = saveMemory(content, embedding, tagList, source, {
        qualityScore: qualityScore ? { score: qualityScore.score, factors: qualityScore.factors } : undefined,
      });
      closeDb();

      const tagStr = tagList.length > 0 ? ` [${tagList.join(', ')}]` : '';
      const qualityStr = qualityScore ? ` ${formatQualityScore(qualityScore)}` : '';
      if (result.isDuplicate) {
        console.log(`⚠ Similar memory exists (id: ${result.id}, ${((result.similarity || 0) * 100).toFixed(0)}% similar)`);
        console.log(`  Skipped duplicate.`);
      } else {
        console.log(`✓ Remembered (id: ${result.id})${tagStr}${qualityStr}`);
        console.log(`  "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`);
      }
    }
  } catch (error: any) {
    console.error('Error saving memory:', error.message);
    closeDb();
    closeGlobalDb();
    process.exit(1);
  }
}

/**
 * Show memory statistics
 */
export function memoryStats(): void {
  try {
    const stats = getMemoryStats();
    closeDb();

    console.log('Memory Statistics:');
    console.log(`  Total memories: ${stats.total_memories}`);
    if (stats.oldest_memory) {
      console.log(`  Oldest: ${new Date(stats.oldest_memory).toLocaleDateString()}`);
    }
    if (stats.newest_memory) {
      console.log(`  Newest: ${new Date(stats.newest_memory).toLocaleDateString()}`);
    }
  } catch (error: any) {
    console.error('Error getting stats:', error.message);
    closeDb();
    process.exit(1);
  }
}

interface ForgetOptions {
  id?: number;
  olderThan?: string;
  tag?: string;
  all?: boolean;
}

/**
 * Forget (delete) memories
 */
export function forget(options: ForgetOptions): void {
  try {
    const { id, olderThan, tag, all } = options;

    // Delete by ID
    if (id !== undefined) {
      const memory = getMemoryById(id);
      if (!memory) {
        console.log(`Memory with id ${id} not found.`);
        closeDb();
        return;
      }

      const deleted = deleteMemory(id);
      closeDb();

      if (deleted) {
        console.log(`✓ Forgot memory ${id}:`);
        console.log(`  "${memory.content.substring(0, 100)}${memory.content.length > 100 ? '...' : ''}"`);
      } else {
        console.log(`Failed to delete memory ${id}`);
      }
      return;
    }

    // Delete older than date
    if (olderThan) {
      const date = parseRelativeDate(olderThan);
      if (!date) {
        console.error(`Invalid date: ${olderThan}`);
        console.log('Use: "30d" (30 days), "1w" (1 week), "3m" (3 months), or ISO date');
        closeDb();
        process.exit(1);
      }

      const count = deleteMemoriesOlderThan(date);
      closeDb();

      console.log(`✓ Forgot ${count} memories older than ${date.toLocaleDateString()}`);
      return;
    }

    // Delete by tag
    if (tag) {
      const count = deleteMemoriesByTag(tag);
      closeDb();

      console.log(`✓ Forgot ${count} memories with tag "${tag}"`);
      return;
    }

    // Delete all
    if (all) {
      const stats = getMemoryStats();
      const count = stats.total_memories;

      if (count === 0) {
        console.log('No memories to delete.');
        closeDb();
        return;
      }

      // Delete all by using a very old date
      const deleted = deleteMemoriesOlderThan(new Date('2100-01-01'));
      closeDb();

      console.log(`✓ Forgot all ${deleted} memories`);
      return;
    }

    // No option specified
    console.log('Specify what to forget:');
    console.log('  --id <id>         Delete memory by ID');
    console.log('  --older-than <d>  Delete memories older than (e.g., "30d", "1w", "3m")');
    console.log('  --tag <tag>       Delete memories with tag');
    console.log('  --all             Delete ALL memories');
    closeDb();
  } catch (error: any) {
    console.error('Error:', error.message);
    closeDb();
    process.exit(1);
  }
}

/**
 * Parse relative date strings like "30d", "1w", "3m"
 */
function parseRelativeDate(input: string): Date | null {
  const now = new Date();

  // Try relative format: 30d, 1w, 3m, 1y
  const match = input.match(/^(\d+)([dwmy])$/i);
  if (match) {
    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case 'd':
        return new Date(now.getTime() - amount * 24 * 60 * 60 * 1000);
      case 'w':
        return new Date(now.getTime() - amount * 7 * 24 * 60 * 60 * 1000);
      case 'm':
        return new Date(now.getTime() - amount * 30 * 24 * 60 * 60 * 1000);
      case 'y':
        return new Date(now.getTime() - amount * 365 * 24 * 60 * 60 * 1000);
    }
  }

  // Try ISO date
  const date = new Date(input);
  if (!isNaN(date.getTime())) {
    return date;
  }

  return null;
}

/**
 * Session Surgeon — trim tool content, thinking blocks, and images
 * from Claude Code JSONL transcripts. Also supports manual compact.
 *
 * All operations modify content within entries (preserving uuid chain).
 * Compact is the only operation that restructures the chain.
 */

import { readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseSessionJSONL, estimateTokens, type TranscriptEntry, type ContentBlock } from './session-analyzer.js';
import { logWarn } from './fault-logger.js';

// ── Types ────────────────────────────────────────────────────────────

export interface TrimOptions {
  /** Only trim named tools (comma-separated or array). */
  tools?: string[];
  /** Only clear tool_use inputs. */
  onlyInputs?: boolean;
  /** Only clear tool_result content. */
  onlyResults?: boolean;
  /** Keep last N lines of tool results. */
  keepLastLines?: number;
  /** Report only, don't write. */
  dryRun?: boolean;
  /** Skip .bak creation. */
  noBackup?: boolean;
}

export interface TrimResult {
  entriesModified: number;
  charsRemoved: number;
  tokensFreed: number;
  backupPath?: string;
}

export interface CompactOptions {
  dryRun?: boolean;
  noBackup?: boolean;
  outputPath?: string;
}

export interface CompactResult {
  preCutMessages: number;
  postCutMessages: number;
  summaryChars: number;
  summaryTokens: number;
  outputPath: string;
  sessionId: string;
  chainVerified: boolean;
}

// ── Trim: Tool Content ───────────────────────────────────────────────

/** Trim tool_use inputs and/or tool_result content from a session JSONL. */
export async function trimToolContent(filePath: string, options: TrimOptions = {}): Promise<TrimResult> {
  const raw = await readFile(filePath, 'utf-8');
  const lines = raw.split('\n');

  const toolFilter = options.tools ? new Set(options.tools) : null;
  const trimInputs = !options.onlyResults; // default: trim both
  const trimResults = !options.onlyInputs; // default: trim both

  let entriesModified = 0;
  let charsRemoved = 0;

  // Collect tool_use names by ID for filtering tool_results
  const toolNameById = new Map<string, string>();

  // First pass: index tool_use IDs → names
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as TranscriptEntry;
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'tool_use' && block.id && block.name) {
          toolNameById.set(block.id, block.name);
        }
      }
    } catch (e) { logWarn('session-surgeon', `Skipping malformed JSONL line in tool_use index pass: ${e}`); }
  }

  // Second pass: trim content
  const newLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      newLines.push(line);
      continue;
    }

    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(trimmed);
    } catch (e) {
      logWarn('session-surgeon', `Skipping malformed JSONL line: ${e}`);
      newLines.push(line);
      continue;
    }

    const content = entry.message?.content;
    if (!Array.isArray(content)) {
      newLines.push(line);
      continue;
    }

    let modified = false;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      // Trim tool_use inputs
      if (block.type === 'tool_use' && trimInputs) {
        if (toolFilter && !toolFilter.has(block.name || '')) continue;
        const serializedInput = block.input ? JSON.stringify(block.input) : '';
        if (serializedInput.length > 2) { // > 2 = not already {}
          block.input = {};
          charsRemoved += serializedInput.length - 2; // subtract replacement '{}' length
          modified = true;
        }
      }

      // Trim tool_result content
      if (block.type === 'tool_result' && trimResults) {
        const toolName = block.tool_use_id ? toolNameById.get(block.tool_use_id) : undefined;
        if (toolFilter && toolName && !toolFilter.has(toolName)) continue;

        const rc = block.content;
        if (typeof rc === 'string' && rc.length > 0) {
          const kept = keepLastLinesOf(rc, options.keepLastLines);
          const replacement = kept || '[trimmed by succ]';
          if (replacement !== rc) {
            const saved = rc.length - replacement.length;
            block.content = replacement;
            charsRemoved += Math.max(0, saved); // don't go negative for short content
            modified = true;
          }
        } else if (Array.isArray(rc)) {
          const serialized = JSON.stringify(rc);
          const replacement = '[trimmed by succ]';
          block.content = replacement;
          charsRemoved += Math.max(0, serialized.length - replacement.length);
          modified = true;
        }
      }
    }

    if (modified) entriesModified++;
    newLines.push(modified ? JSON.stringify(entry) : line);
  }

  const result: TrimResult = {
    entriesModified,
    charsRemoved,
    tokensFreed: estimateTokens(charsRemoved),
  };

  if (!options.dryRun) {
    if (!options.noBackup) {
      const backupPath = filePath + '.bak';
      await copyFile(filePath, backupPath);
      result.backupPath = backupPath;
    }
    await writeFile(filePath, newLines.join('\n'), 'utf-8');
  }

  return result;
}

// ── Trim: Thinking Blocks ────────────────────────────────────────────

/** Trim thinking blocks from a session JSONL. */
export async function trimThinking(
  filePath: string,
  options: Pick<TrimOptions, 'dryRun' | 'noBackup'> = {}
): Promise<TrimResult> {
  const raw = await readFile(filePath, 'utf-8');
  const lines = raw.split('\n');

  let entriesModified = 0;
  let charsRemoved = 0;

  const newLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      newLines.push(line);
      continue;
    }

    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(trimmed);
    } catch (e) {
      logWarn('session-surgeon', `Skipping malformed JSONL line: ${e}`);
      newLines.push(line);
      continue;
    }

    const content = entry.message?.content;
    if (!Array.isArray(content)) {
      newLines.push(line);
      continue;
    }

    let modified = false;
    const replacement = '[trimmed by succ]';
    for (const block of content) {
      if (block?.type === 'thinking' && block.thinking && block.thinking !== replacement) {
        charsRemoved += Math.max(0, block.thinking.length - replacement.length);
        block.thinking = replacement;
        modified = true;
      }
    }

    if (modified) entriesModified++;
    newLines.push(modified ? JSON.stringify(entry) : line);
  }

  const result: TrimResult = {
    entriesModified,
    charsRemoved,
    tokensFreed: estimateTokens(charsRemoved),
  };

  if (!options.dryRun) {
    if (!options.noBackup) {
      const backupPath = filePath + '.bak';
      await copyFile(filePath, backupPath);
      result.backupPath = backupPath;
    }
    await writeFile(filePath, newLines.join('\n'), 'utf-8');
  }

  return result;
}

// ── Trim: All ────────────────────────────────────────────────────────

/** Trim all strippable content (tool inputs, results, thinking, images). */
export async function trimAll(
  filePath: string,
  options: Pick<TrimOptions, 'dryRun' | 'noBackup'> = {}
): Promise<TrimResult> {
  const raw = await readFile(filePath, 'utf-8');
  const lines = raw.split('\n');

  let entriesModified = 0;
  let charsRemoved = 0;

  const newLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      newLines.push(line);
      continue;
    }

    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(trimmed);
    } catch (e) {
      logWarn('session-surgeon', `Skipping malformed JSONL line: ${e}`);
      newLines.push(line);
      continue;
    }

    const content = entry.message?.content;
    if (!Array.isArray(content)) {
      newLines.push(line);
      continue;
    }

    let modified = false;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'tool_use' && block.input) {
        const len = JSON.stringify(block.input).length;
        if (len > 2) { // > 2 = not already {}
          block.input = {};
          charsRemoved += len - 2; // subtract replacement '{}' length
          modified = true;
        }
      }

      if (block.type === 'tool_result') {
        const rc = block.content;
        const replacement = '[trimmed by succ]';
        if (typeof rc === 'string' && rc.length > 0 && rc !== replacement) {
          charsRemoved += Math.max(0, rc.length - replacement.length);
          block.content = replacement;
          modified = true;
        } else if (Array.isArray(rc)) {
          charsRemoved += Math.max(0, JSON.stringify(rc).length - replacement.length);
          block.content = replacement;
          modified = true;
        }
      }

      if (block.type === 'thinking' && block.thinking) {
        const replacement = '[trimmed by succ]';
        if (block.thinking !== replacement) {
          charsRemoved += Math.max(0, block.thinking.length - replacement.length);
          block.thinking = replacement;
          modified = true;
        }
      }

      if (block.type === 'image' && block.source) {
        const sourceLen = JSON.stringify(block.source).length;
        const replacementLen = JSON.stringify({ type: 'trimmed' }).length;
        charsRemoved += Math.max(0, sourceLen - replacementLen);
        block.source = { type: 'trimmed' };
        modified = true;
      }
    }

    if (modified) entriesModified++;
    newLines.push(modified ? JSON.stringify(entry) : line);
  }

  const result: TrimResult = {
    entriesModified,
    charsRemoved,
    tokensFreed: estimateTokens(charsRemoved),
  };

  if (!options.dryRun) {
    if (!options.noBackup) {
      const backupPath = filePath + '.bak';
      await copyFile(filePath, backupPath);
      result.backupPath = backupPath;
    }
    await writeFile(filePath, newLines.join('\n'), 'utf-8');
  }

  return result;
}

// ── Compact ──────────────────────────────────────────────────────────

/** Compact a session by summarizing everything before a given position. */
export async function compactBefore(
  filePath: string,
  beforePos: number,
  options: CompactOptions = {}
): Promise<CompactResult> {
  const raw = await readFile(filePath, 'utf-8');
  const entries = parseSessionJSONL(raw);

  if (beforePos < 1 || beforePos >= entries.length) {
    throw new Error(`Invalid beforePos=${beforePos}. Valid range: 1..${entries.length - 1}`);
  }

  const preCut = entries.slice(0, beforePos);
  const postCut = entries.slice(beforePos);

  // Extract dialogue from pre-cut
  const dialogueText = extractDialogue(preCut);

  // Extract cwd and version from first entry that has them
  let cwd: string | undefined;
  let version: string | undefined;
  for (const entry of entries) {
    if (!cwd && (entry as Record<string, unknown>).cwd) cwd = (entry as Record<string, unknown>).cwd as string;
    if (!version && (entry as Record<string, unknown>).version) version = (entry as Record<string, unknown>).version as string;
    if (cwd && version) break;
  }

  const newSessionId = randomUUID();
  const boundaryUuid = randomUUID();
  const summaryUuid = randomUUID();
  const slug = `compact-${newSessionId.slice(0, 8)}`;
  const baseTs = new Date().toISOString();

  // Build new JSONL
  const newEntries: Record<string, unknown>[] = [];

  // Line 0: compact_boundary
  newEntries.push({
    parentUuid: null,
    type: 'system',
    subtype: 'compact_boundary',
    uuid: boundaryUuid,
    sessionId: newSessionId,
    slug,
    timestamp: baseTs,
    isSidechain: false,
    userType: 'external',
    cwd,
    version,
    level: 'info',
    isMeta: false,
    content: 'Conversation compacted by succ',
    compactMetadata: {
      trigger: 'manual',
      preTokens: estimateTokens(preCut.reduce((sum, e) => sum + JSON.stringify(e).length, 0)),
    },
  });

  // Line 1: compact summary
  newEntries.push({
    parentUuid: boundaryUuid,
    type: 'user',
    uuid: summaryUuid,
    sessionId: newSessionId,
    slug,
    timestamp: offsetTs(baseTs, 1),
    isSidechain: false,
    userType: 'external',
    cwd,
    version,
    message: {
      role: 'user',
      content: `[Prior context summary]:\n\n${dialogueText}`,
    },
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  });

  // Remap UUIDs for post-cut
  const oldToNew = new Map<string, string>();
  for (const entry of postCut) {
    if (entry.uuid) {
      oldToNew.set(entry.uuid, randomUUID());
    }
  }

  // Lines 2+: post-cut entries with fresh UUIDs
  for (let i = 0; i < postCut.length; i++) {
    const original = postCut[i];
    const newEntry = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;

    // Assign new UUID
    if (original.uuid) {
      newEntry.uuid = oldToNew.get(original.uuid)!;
    }

    // Remap parentUuid
    if (i === 0) {
      newEntry.parentUuid = summaryUuid;
    } else {
      const oldParent = original.parentUuid;
      if (oldParent && oldToNew.has(oldParent)) {
        newEntry.parentUuid = oldToNew.get(oldParent);
      } else {
        // Parent was in preCut or missing — link to previous entry for linear chain
        const prevEntry = postCut[i - 1];
        newEntry.parentUuid = prevEntry.uuid ? oldToNew.get(prevEntry.uuid) : summaryUuid;
      }
    }

    newEntry.sessionId = newSessionId;
    newEntry.slug = slug;
    newEntry.timestamp = offsetTs(baseTs, 2000 + i * 500);

    // Remove forkedFrom if present
    delete newEntry.forkedFrom;

    newEntries.push(newEntry);
  }

  // Verify chain
  const chainVerified = verifyChain(newEntries);

  // Determine output path
  const outputPath = options.outputPath || filePath.replace(/\.jsonl$/, `-compact-${newSessionId.slice(0, 8)}.jsonl`);

  const result: CompactResult = {
    preCutMessages: preCut.length,
    postCutMessages: postCut.length,
    summaryChars: dialogueText.length,
    summaryTokens: estimateTokens(dialogueText.length),
    outputPath,
    sessionId: newSessionId,
    chainVerified,
  };

  if (!options.dryRun) {
    if (!options.noBackup) {
      await copyFile(filePath, filePath + '.bak');
    }
    const output = newEntries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(outputPath, output, 'utf-8');
  }

  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Extract human-readable dialogue from entries (user/assistant text only). */
export function extractDialogue(entries: TranscriptEntry[]): string {
  const lines: string[] = [];

  for (const entry of entries) {
    const role = entry.message?.role || entry.type;
    const content = entry.message?.content;

    if (role === 'user' || entry.type === 'user') {
      const text = extractText(content);
      if (!text) continue;
      // Skip commands and interrupts
      if (text.includes('<command-name>') || text.includes('<local-command')) continue;
      if (text.includes('[Request interrupted')) continue;
      lines.push(`User: ${text.trim()}`);
    }

    if (role === 'assistant' || entry.type === 'assistant') {
      const text = extractText(content);
      if (text) lines.push(`Assistant: ${text.trim()}`);
    }
  }

  return lines.join('\n\n');
}

/** Extract text content from string or content block array. */
function extractText(content: string | ContentBlock[] | null | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join(' ');
}

/** Keep only the last N lines of a string. Returns empty string if keepLastLines is 0 or undefined. */
function keepLastLinesOf(text: string, keepLastLines: number | undefined): string {
  if (!keepLastLines || keepLastLines <= 0) return '';
  const lines = text.split('\n');
  if (lines.length <= keepLastLines) return text;
  return lines.slice(-keepLastLines).join('\n');
}

/** Offset an ISO timestamp by milliseconds. */
function offsetTs(baseIso: string, ms: number): string {
  const dt = new Date(baseIso);
  dt.setTime(dt.getTime() + ms);
  return dt.toISOString();
}

/** Verify that a chain of entries walks from last to root (null parentUuid). */
function verifyChain(entries: Record<string, unknown>[]): boolean {
  const uuidIndex = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (entry.uuid) uuidIndex.set(entry.uuid as string, entry);
  }

  // Walk from last entry to root
  let current = entries[entries.length - 1];
  const visited = new Set<string>();

  while (current) {
    const uuid = current.uuid as string;
    if (visited.has(uuid)) return false; // cycle
    visited.add(uuid);

    const parentUuid = current.parentUuid as string | null;
    if (parentUuid === null || parentUuid === undefined) return true; // reached root
    current = uuidIndex.get(parentUuid)!;
    if (!current) return false; // broken link
  }

  return false;
}

/**
 * Shared transcript content helpers.
 *
 * Used by daemon/session and idle-context processors to keep parsing behavior
 * consistent across transcript consumers.
 */

import { readFile } from 'node:fs/promises';
import { logWarn } from './fault-logger.js';

// ── Content block types ───────────────────────────────────────────────

/** A single content block inside a message's content array. */
export interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  thinking?: string;
  source?: { type?: string };
  [key: string]: unknown;
}

/** @deprecated Use ContentBlock instead */
export interface TranscriptBlock {
  type?: string;
  text?: string;
}

export type TranscriptContent = string | ContentBlock[] | null | undefined;

/** A single JSONL transcript entry — superset of all consumer definitions. */
export interface TranscriptEntry {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  slug?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  tool_name?: string;
  tool_input?: unknown;
  tool_result?: unknown;
}

export interface TranscriptMessage {
  type?: string;
  message?: {
    content?: TranscriptContent;
  };
}

// ── JSONL parsing ─────────────────────────────────────────────────────

/** Parse a JSONL string into transcript entries, skipping malformed lines. */
export function parseJSONL(content: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as TranscriptEntry);
    } catch (e) {
      logWarn('transcript-utils', `Skipping malformed JSONL line: ${e}`);
    }
  }
  return entries;
}

/** Read a JSONL file and parse it into transcript entries. */
export async function parseJSONLFile(filePath: string): Promise<TranscriptEntry[]> {
  const content = await readFile(filePath, 'utf-8');
  return parseJSONL(content);
}

export function getTextContent(content: TranscriptContent): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is ContentBlock & { text: string } => {
        return block?.type === 'text' && typeof block.text === 'string';
      })
      .map((block) => block.text)
      .join(' ');
  }
  return '';
}

export function formatTranscriptLines(
  messages: TranscriptMessage[],
  opts: { assistantLimit?: number; userLimit?: number } = {}
): string[] {
  const assistantLimit = opts.assistantLimit ?? 1000;
  const userLimit = opts.userLimit ?? 500;
  const lines: string[] = [];

  for (const entry of messages) {
    if (entry.type === 'assistant' && entry.message?.content) {
      const text = getTextContent(entry.message.content);
      if (text) lines.push(`Assistant: ${text.substring(0, assistantLimit)}`);
      continue;
    }

    if ((entry.type === 'human' || entry.type === 'user') && entry.message?.content) {
      const text = getTextContent(entry.message.content);
      if (text) lines.push(`User: ${text.substring(0, userLimit)}`);
    }
  }

  return lines;
}

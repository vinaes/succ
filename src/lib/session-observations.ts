/**
 * Session Observation Accumulator
 *
 * Maintains append-only observation files per session for prompt caching.
 * When the daemon extracts facts mid-session, they're appended here.
 * On session end, the file is used for final extraction (avoids re-processing
 * already-extracted content).
 *
 * Benefits:
 * - Prompt caching: unchanged prefix of observations stays cached (2-3x cost reduction)
 * - Dedup-free re-extraction: daemon knows what was already extracted
 * - Session continuity: if daemon restarts, observations survive on disk
 *
 * Files stored at: .succ/observations/{sessionId}.jsonl (JSON Lines format)
 */

import fs from 'fs';
import path from 'path';
import { getSuccDir } from './config.js';

export interface Observation {
  /** Extracted fact content */
  content: string;
  /** Memory type assigned */
  type: string;
  /** Tags assigned */
  tags: string[];
  /** Timestamp of extraction */
  extractedAt: string;
  /** Source: 'mid-session-observer' | 'session-end' | 'manual' */
  source: string;
  /** Transcript byte offset at time of extraction */
  transcriptOffset?: number;
  /** Memory ID if saved, null if skipped */
  memoryId: number | null;
}

/**
 * Get the observations directory, creating it if needed.
 */
function getObservationsDir(): string {
  const dir = path.join(getSuccDir(), 'observations');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get the observation file path for a session.
 */
function getObservationFile(sessionId: string): string {
  return path.join(getObservationsDir(), `${sessionId}.jsonl`);
}

/**
 * Append observations for a session.
 * Uses JSON Lines format (one JSON object per line) for efficient append.
 */
export function appendObservations(sessionId: string, observations: Observation[]): void {
  if (observations.length === 0) return;

  const filePath = getObservationFile(sessionId);
  const lines = observations.map((obs) => JSON.stringify(obs)).join('\n') + '\n';

  fs.appendFileSync(filePath, lines, 'utf-8');
}

/**
 * Read all observations for a session.
 */
export function readObservations(sessionId: string): Observation[] {
  const filePath = getObservationFile(sessionId);
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);

  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as Observation;
      } catch {
        return null;
      }
    })
    .filter((obs): obs is Observation => obs !== null);
}

/**
 * Get observation count for a session (without reading all content).
 */
export function getObservationCount(sessionId: string): number {
  const filePath = getObservationFile(sessionId);
  if (!fs.existsSync(filePath)) return 0;

  const content = fs.readFileSync(filePath, 'utf-8');
  return content.split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * Get all observation content as a single string (for prompt caching / re-extraction).
 * Returns already-extracted facts formatted for LLM context.
 */
export function getObservationContext(sessionId: string): string {
  const observations = readObservations(sessionId);
  if (observations.length === 0) return '';

  return observations.map((obs, i) => `${i + 1}. [${obs.type}] ${obs.content}`).join('\n');
}

/**
 * Clean up observation file for a session (session ended, processing complete).
 */
export function removeObservations(sessionId: string): void {
  const filePath = getObservationFile(sessionId);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Non-critical
  }
}

/**
 * Clean up stale observation files (older than maxAge hours).
 * Run periodically to prevent disk bloat from orphaned sessions.
 */
export function cleanupStaleObservations(maxAgeHours: number = 48): number {
  const dir = getObservationsDir();
  if (!fs.existsSync(dir)) return 0;

  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  let cleaned = 0;

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const filePath = path.join(dir, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        cleaned++;
      }
    } catch {
      // Skip files we can't stat
    }
  }

  return cleaned;
}

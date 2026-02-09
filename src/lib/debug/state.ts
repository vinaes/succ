/**
 * Debug Session State Management
 *
 * File-based CRUD for debug sessions in .succ/debugs/.
 * Follows the same pattern as PRD state (file-based, not StorageBackend).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getSuccDir } from '../config.js';
import type { DebugSession, DebugSessionIndexEntry } from './types.js';
import { sessionToIndexEntry } from './types.js';

// ============================================================================
// Path helpers
// ============================================================================

function getDebugsDir(): string {
  return path.join(getSuccDir(), 'debugs');
}

function getSessionDir(sessionId: string): string {
  return path.join(getDebugsDir(), sessionId);
}

function getIndexPath(): string {
  return path.join(getDebugsDir(), 'index.json');
}

function getSessionJsonPath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), 'session.json');
}

function getLogsDir(sessionId: string): string {
  return path.join(getSessionDir(sessionId), 'logs');
}

// ============================================================================
// Directory setup
// ============================================================================

export function ensureDebugsDir(): void {
  const dir = getDebugsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ensureSessionDir(sessionId: string): void {
  const dir = getSessionDir(sessionId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const logsDir = getLogsDir(sessionId);
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
}

// ============================================================================
// ID generation
// ============================================================================

export function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex');
  return `dbg_${timestamp}_${random}`;
}

// ============================================================================
// Index operations
// ============================================================================

function loadIndex(): DebugSessionIndexEntry[] {
  const indexPath = getIndexPath();
  if (!fs.existsSync(indexPath)) return [];
  return JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
}

function saveIndex(entries: DebugSessionIndexEntry[]): void {
  ensureDebugsDir();
  fs.writeFileSync(getIndexPath(), JSON.stringify(entries, null, 2));
}

function upsertIndex(entry: DebugSessionIndexEntry): void {
  const entries = loadIndex();
  const idx = entries.findIndex(e => e.id === entry.id);
  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }
  saveIndex(entries);
}

// ============================================================================
// Session CRUD
// ============================================================================

export function saveSession(session: DebugSession): void {
  ensureSessionDir(session.id);
  session.updated_at = new Date().toISOString();
  fs.writeFileSync(getSessionJsonPath(session.id), JSON.stringify(session, null, 2));
  upsertIndex(sessionToIndexEntry(session));
}

export function loadSession(sessionId: string): DebugSession | null {
  const jsonPath = getSessionJsonPath(sessionId);
  if (!fs.existsSync(jsonPath)) return null;
  return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
}

export function deleteSession(sessionId: string): void {
  const dir = getSessionDir(sessionId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const entries = loadIndex().filter(e => e.id !== sessionId);
  saveIndex(entries);
}

export function listSessions(includeResolved = false): DebugSessionIndexEntry[] {
  const entries = loadIndex();
  if (includeResolved) return entries;
  return entries.filter(e => e.status === 'active');
}

export function findActiveSession(): DebugSessionIndexEntry | null {
  const active = loadIndex().filter(e => e.status === 'active');
  if (active.length === 0) return null;
  return active.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

// ============================================================================
// Session log
// ============================================================================

export function appendSessionLog(sessionId: string, entry: string): void {
  ensureSessionDir(sessionId);
  const logPath = path.join(getLogsDir(sessionId), 'debug.log');
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  fs.appendFileSync(logPath, `[${timestamp}] ${entry}\n`);
}

export function loadSessionLog(sessionId: string): string {
  const logPath = path.join(getLogsDir(sessionId), 'debug.log');
  if (!fs.existsSync(logPath)) return '';
  return fs.readFileSync(logPath, 'utf-8');
}

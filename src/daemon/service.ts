/**
 * Unified Daemon Service for succ
 *
 * Single HTTP server per project that handles:
 * - Multiple Claude Code sessions (idle tracking, reflection)
 * - Watch service (file monitoring)
 * - Analyze queue (code analysis)
 * - Data operations (search, recall, remember)
 *
 * Benefits:
 * - No CMD windows on Windows (starts once, stays running)
 * - Fast operations via HTTP (~5ms vs ~500ms spawn)
 * - Shared DB connections, embeddings cache
 * - Per-session idle tracking with multi-session support
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createSessionManager, createIdleWatcher, type SessionState } from './sessions.js';
import { logError, logWarn } from '../lib/fault-logger.js';
import { processSessionEnd } from './session-processor.js';
import { ValidationError, NotFoundError, NetworkError } from '../lib/errors.js';
import { startWatcher, stopWatcher, getWatcherStatus, indexFileOnDemand } from './watcher.js';
import { startAnalyzer, stopAnalyzer, getAnalyzerStatus, triggerAnalysis } from './analyzer.js';
import { getProjectRoot, getSuccDir, getIdleReflectionConfig, getIdleWatcherConfig, getConfig, getObserverConfig } from '../lib/config.js';
import {
  hybridSearchDocs,
  hybridSearchCode,
  hybridSearchMemories,
  saveMemory,
  closeDb,
  getStats,
  getMemoryStats,
  incrementMemoryAccessBatch,
  autoLinkSimilarMemories,
  getRecentMemories,
  // Global memory
  saveGlobalMemory,
  closeGlobalDb,
  // Dispatcher lifecycle
  initStorageDispatcher,
  closeStorageDispatcher,
  getStorageDispatcher,
} from '../lib/storage/index.js';
import { getEmbedding, cleanupEmbeddings } from '../lib/embeddings.js';
import { scoreMemory, passesQualityThreshold, cleanupQualityScoring } from '../lib/quality.js';
import { scanSensitive } from '../lib/sensitive-filter.js';
import { generateCompactBriefing } from '../lib/compact-briefing.js';
import { callLLM, isSleepAgentEnabled } from '../lib/llm.js';
import { extractSessionSummary } from '../lib/session-summary.js';
import { recordTranscriptTokens, recordExtraction, resetTranscriptCounter, loadBudgets, flushBudgets, removeBudget } from '../lib/token-budget.js';
import { appendObservations, removeObservations, cleanupStaleObservations, type Observation } from '../lib/session-observations.js';
import { REFLECTION_PROMPT } from '../prompts/index.js';

// ============================================================================
// Types
// ============================================================================

export interface DaemonConfig {
  port_range_start: number;
  idle_minutes: number;
  check_interval_seconds: number;
  reflection_cooldown_minutes: number;
}

export interface DaemonState {
  cwd: string;
  startedAt: number;
  port: number;
  server: http.Server | null;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_PORT_RANGE_START = 37842;
const MAX_PORT_ATTEMPTS = 100;

// ============================================================================
// Daemon State
// ============================================================================

let state: DaemonState | null = null;
let sessionManager: ReturnType<typeof createSessionManager> | null = null;
let idleWatcher: ReturnType<typeof createIdleWatcher> | null = null;

// Briefing cache for pre-generated compact briefings
interface BriefingCache {
  briefing: string;
  generatedAt: number;
  transcriptSize: number;
}
const briefingCache = new Map<string, BriefingCache>();
const briefingGenerationInProgress = new Set<string>();

// In-flight dedup: prevents race condition when identical /api/remember requests
// arrive within a short window (e.g. hook fires twice for same tool_use)
const rememberInFlight = new Map<string, Promise<any>>();
const REMEMBER_DEDUP_TTL_MS = 5000;

// ============================================================================
// File Paths
// ============================================================================

function getDaemonPidFile(): string {
  const succDir = getSuccDir();
  const tmpDir = path.join(succDir, '.tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  return path.join(tmpDir, 'daemon.pid');
}

// ============================================================================
// Progress File Management
// ============================================================================

/**
 * Get path to session progress file
 * Progress files accumulate idle reflection briefings for session-end processing
 */
function getProgressFilePath(sessionId: string): string {
  const succDir = getSuccDir();
  const tmpDir = path.join(succDir, '.tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  return path.join(tmpDir, `session-${sessionId}-progress.md`);
}

/**
 * Append a briefing to the session progress file
 * Creates file with header if it doesn't exist
 */
export function appendToProgressFile(sessionId: string, briefing: string): void {
  const progressPath = getProgressFilePath(sessionId);
  const timestamp = new Date().toISOString();
  const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

  let content = '';
  if (!fs.existsSync(progressPath)) {
    content = `---\nsession_id: ${sessionId}\ncreated: ${timestamp}\n---\n\n`;
  }

  content += `## ${timeStr} - Idle Reflection\n\n`;
  content += briefing;
  content += '\n\n---\n\n';

  fs.appendFileSync(progressPath, content);
}

/**
 * Read tail of transcript file (for fallback when no progress file)
 * Returns the last maxBytes of the file, starting from a complete line
 */
export function readTailTranscript(transcriptPath: string, maxBytes: number = 2 * 1024 * 1024): string {
  if (!fs.existsSync(transcriptPath)) {
    return '';
  }

  const stats = fs.statSync(transcriptPath);
  if (stats.size <= maxBytes) {
    return fs.readFileSync(transcriptPath, 'utf8');
  }

  // Read only tail
  const fd = fs.openSync(transcriptPath, 'r');
  const buffer = Buffer.alloc(maxBytes);
  fs.readSync(fd, buffer, 0, maxBytes, stats.size - maxBytes);
  fs.closeSync(fd);

  // Find first complete line (skip partial line at start)
  const content = buffer.toString('utf8');
  const firstNewline = content.indexOf('\n');
  return firstNewline > 0 ? content.slice(firstNewline + 1) : content;
}

// ============================================================================
// Briefing Pre-Generation
// ============================================================================

const BRIEFING_CACHE_MAX_AGE_MS = 5 * 60 * 1000;  // 5 minutes
const BRIEFING_MIN_TRANSCRIPT_GROWTH = 5000;  // Re-generate after 5KB growth
const BRIEFING_PREGENERATE_IDLE_MS = 120 * 1000;  // Pre-generate after 2 min idle

/**
 * Pre-generate briefing for a session in background
 * Called when session is idle or transcript grows significantly
 */
async function preGenerateBriefing(sessionId: string, transcriptPath: string): Promise<void> {
  // Skip if already generating
  if (briefingGenerationInProgress.has(sessionId)) {
    return;
  }

  if (!fs.existsSync(transcriptPath)) {
    return;
  }

  const stats = fs.statSync(transcriptPath);
  const currentSize = stats.size;

  // Check if we need to regenerate
  const cached = briefingCache.get(sessionId);
  if (cached) {
    const age = Date.now() - cached.generatedAt;
    const growth = currentSize - cached.transcriptSize;

    // Skip if cache is fresh and transcript hasn't grown much
    if (age < BRIEFING_CACHE_MAX_AGE_MS && growth < BRIEFING_MIN_TRANSCRIPT_GROWTH) {
      return;
    }
  }

  briefingGenerationInProgress.add(sessionId);
  log(`[briefing] Pre-generating for session ${sessionId.slice(0, 8)}...`);

  try {
    const transcriptContent = fs.readFileSync(transcriptPath, 'utf-8');
    const result = await generateCompactBriefing(transcriptContent);

    if (result.success && result.briefing) {
      briefingCache.set(sessionId, {
        briefing: result.briefing,
        generatedAt: Date.now(),
        transcriptSize: currentSize,
      });
      log(`[briefing] Pre-generated for session ${sessionId.slice(0, 8)} (${result.briefing.length} chars)`);
    } else {
      log(`[briefing] Pre-generation failed: ${result.error}`);
    }
  } catch (error) {
    log(`[briefing] Pre-generation error: ${error}`);
  } finally {
    briefingGenerationInProgress.delete(sessionId);
  }
}

/**
 * Get cached briefing or generate on-demand
 */
async function getCachedBriefing(sessionId: string, transcriptPath: string): Promise<{ briefing?: string; cached: boolean }> {
  const cached = briefingCache.get(sessionId);

  if (cached) {
    // Check if cache is still valid
    const age = Date.now() - cached.generatedAt;
    if (age < BRIEFING_CACHE_MAX_AGE_MS) {
      return { briefing: cached.briefing, cached: true };
    }
  }

  // Cache miss or stale - generate fresh
  if (!fs.existsSync(transcriptPath)) {
    return { cached: false };
  }

  const transcriptContent = fs.readFileSync(transcriptPath, 'utf-8');
  const result = await generateCompactBriefing(transcriptContent);

  if (result.success && result.briefing) {
    const stats = fs.statSync(transcriptPath);
    briefingCache.set(sessionId, {
      briefing: result.briefing,
      generatedAt: Date.now(),
      transcriptSize: stats.size,
    });
    return { briefing: result.briefing, cached: false };
  }

  return { cached: false };
}

/**
 * Clear briefing cache for a session (called when session ends)
 */
function clearBriefingCache(sessionId: string): void {
  briefingCache.delete(sessionId);
  briefingGenerationInProgress.delete(sessionId);
}

function getDaemonPortFile(): string {
  const succDir = getSuccDir();
  const tmpDir = path.join(succDir, '.tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  return path.join(tmpDir, 'daemon.port');
}

function getDaemonLogFile(): string {
  const succDir = getSuccDir();
  return path.join(succDir, 'daemon.log');
}

// ============================================================================
// Logging
// ============================================================================

function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;

  // Write to daemon.log
  try {
    fs.appendFileSync(getDaemonLogFile(), line);
  } catch (err) {
    logWarn('daemon', 'Failed to write daemon log', { error: err instanceof Error ? err.message : String(err) });
  }

  // Also write to stderr for debugging
  process.stderr.write(line);
}

// ============================================================================
// Write Reflection
// ============================================================================

/**
 * Write a human-like reflection to the brain vault
 * Uses Claude CLI or local LLM to generate introspective text
 */
async function writeReflection(
  transcript: string,
  idleConfig: ReturnType<typeof getIdleReflectionConfig>
): Promise<void> {
  const projectRoot = getProjectRoot();
  const reflectionsDir = path.join(projectRoot, '.succ', 'brain', 'Reflections');

  // Create reflections directory if needed
  if (!fs.existsSync(reflectionsDir)) {
    fs.mkdirSync(reflectionsDir, { recursive: true });
  }

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0].substring(0, 5);
  const timestamp = `${dateStr} ${timeStr}`;

  const prompt = REFLECTION_PROMPT.replace('{transcript}', transcript.substring(0, 3000));

  let reflectionText: string | null = null;

  // Use sleep agent for background reflection if enabled
  try {
    reflectionText = await callLLM(prompt, {
      timeout: 60000,
      useSleepAgent: true,  // Use sleep_agent config if available
    });
  } catch (err) {
    log(`[reflection] LLM call failed: ${err}`);
    reflectionText = null;
  }

  if (!reflectionText || reflectionText.trim().length < 50) {
    log(`[reflection] Reflection text too short or empty, skipping`);
    return;
  }

  // Write reflection file with YAML frontmatter
  const reflectionFile = path.join(reflectionsDir, `${timestamp}.md`);
  const content = `---
date: ${dateStr}
time: ${timeStr}
trigger: idle
tags:
  - reflection
---

# Reflection ${dateStr} ${timeStr}

${reflectionText.trim()}
`;

  fs.writeFileSync(reflectionFile, content);

  // Also save to memory
  const embedding = await getEmbedding(reflectionText.trim());
  await saveMemory(reflectionText.trim(), embedding, ['reflection'], 'observation', {
    qualityScore: { score: 0.6, factors: { hasContext: 1 } },
  });
}

// LLM functions moved to shared module: src/lib/llm.ts

// ============================================================================
// Reflection Handler
// ============================================================================

async function handleReflection(sessionId: string, session: SessionState): Promise<void> {
  // Skip reflection for service sessions (reflection subagents, analyzers, etc.)
  if (session.isService) {
    log(`[reflection] Skipping service session ${sessionId}`);
    return;
  }

  log(`[reflection] Starting reflection for session ${sessionId}`);

  const idleConfig = getIdleReflectionConfig();

  // Only run if we have a transcript
  if (!session.transcriptPath || !fs.existsSync(session.transcriptPath)) {
    log(`[reflection] No transcript found for session ${sessionId}`);
    return;
  }

  try {
    // ── Change detection: skip redundant work during long AFK ──
    let transcriptChanged = true;
    let memoriesChanged = true;

    try {
      const currentSize = fs.statSync(session.transcriptPath).size;
      if (session.lastTranscriptSize !== undefined && currentSize === session.lastTranscriptSize) {
        transcriptChanged = false;
        log(`[reflection] Transcript unchanged (${currentSize}b), skipping briefing`);
      }
      session.lastTranscriptSize = currentSize;
    } catch { /* transcript file gone — skip size check */ }

    // Check memory count for consolidation skip
    const memStats = await getMemoryStats();
    const currentMemCount = memStats.total;
    if (session.lastMemoryCount !== undefined && currentMemCount === session.lastMemoryCount) {
      memoriesChanged = false;
    }
    session.lastMemoryCount = currentMemCount;

    // ── Mid-conversation observer: extract facts when enough new content ──
    const observerConfig = getObserverConfig();
    if (observerConfig.enabled && transcriptChanged) {
      try {
        const currentSize = session.lastTranscriptSize ?? 0;
        const lastObsSize = session.lastObservationSize ?? 0;
        const lastObsTime = session.lastObservation ?? session.registeredAt;
        const now = Date.now();

        // Read new content and track real token count via budget
        const newBytes = currentSize - lastObsSize;
        const timeThresholdMs = observerConfig.max_minutes * 60 * 1000;
        const enoughTime = (now - lastObsTime) >= timeThresholdMs;

        // Use byte-estimated token check first (cheap), then verify with real count
        const estimatedTokens = Math.ceil(newBytes / 3.5);
        const enoughNewContent = estimatedTokens >= observerConfig.min_tokens;

        if (enoughNewContent || enoughTime) {
          const newContent = readTailTranscript(session.transcriptPath, newBytes);

          // Track real tokens in budget
          const realTokens = recordTranscriptTokens(sessionId, newContent);
          log(`[observer] Triggering extraction (tokens: ~${realTokens}, time: ${Math.round((now - lastObsTime) / 60000)}min)`);

          if (newContent.length > 200) {
            const result = await extractSessionSummary(newContent, { verbose: false });
            recordExtraction(sessionId,
              result.transcriptTokens ?? 0,
              result.summaryTokens ?? 0,
              result.factsExtracted,
              result.factsSaved
            );
            resetTranscriptCounter(sessionId);

            // Persist extraction metadata to session observations (append-only)
            if (result.factsSaved > 0) {
              appendObservations(sessionId, [{
                content: `Extracted ${result.factsExtracted} facts, saved ${result.factsSaved}`,
                type: 'observation',
                tags: ['mid-session'],
                extractedAt: new Date().toISOString(),
                source: 'mid-session-observer',
                transcriptOffset: currentSize,
                memoryId: null,
              }]);
            }
            log(`[observer] Extracted ${result.factsExtracted} facts, saved ${result.factsSaved} (skipped ${result.factsSkipped})`);
          }

          session.lastObservation = now;
          session.lastObservationSize = currentSize;
          flushBudgets();
        }
      } catch (err) {
        log(`[observer] Mid-session extraction failed: ${err}`);
      }
    }

    // ── Generate briefing (skip if transcript unchanged) ──
    let briefingResult: { success: boolean; briefing?: string } = { success: false };

    if (transcriptChanged) {
      const transcriptContent = readTailTranscript(session.transcriptPath, 100 * 1024); // 100KB max
      briefingResult = await generateCompactBriefing(transcriptContent, {
        format: 'structured',
        include_memories: true,
        max_memories: 3,
      });

      if (briefingResult.success && briefingResult.briefing) {
        appendToProgressFile(sessionId, briefingResult.briefing);
        log(`[reflection] Appended briefing to progress file (${briefingResult.briefing.length} chars)`);
      } else {
        log(`[reflection] Failed to generate briefing for ${sessionId}`);
      }
    }

    // ── Parallel operations ──
    const globalConfig = getConfig();
    const parallelOps: Promise<void>[] = [];

    // memory_consolidation - skip if no new memories (disabled by default, opt-in only)
    if (memoriesChanged && idleConfig.operations?.memory_consolidation === true) {
      parallelOps.push((async () => {
        const threshold = idleConfig.thresholds?.similarity_for_merge ?? 0.92;
        const limit = idleConfig.max_memories_to_process ?? 50;

        log(`[reflection] Running memory consolidation (threshold=${threshold}, limit=${limit})`);
        const { consolidate } = await import('../commands/consolidate.js');
        await consolidate({
          threshold: String(threshold),
          limit: String(limit),
          llm: true,
          verbose: false,
        });
        log(`[reflection] Memory consolidation complete`);
      })());
    }

    // retention_cleanup - independent (always runs if enabled)
    if (globalConfig.retention?.enabled && idleConfig.operations?.retention_cleanup !== false) {
      parallelOps.push((async () => {
        log(`[reflection] Running retention cleanup`);
        const { retention } = await import('../commands/retention.js');
        await retention({ apply: true, verbose: false });
        log(`[reflection] Retention cleanup complete`);
      })());
    }

    await Promise.all(parallelOps);

    // ── Graph refinement: auto-link (depends on consolidation completing first) ──
    let newLinksCreated = 0;
    if (idleConfig.operations?.graph_refinement !== false) {
      log(`[reflection] Running graph auto-link`);
      const threshold = idleConfig.thresholds?.auto_link_threshold ?? 0.75;
      newLinksCreated = (await autoLinkSimilarMemories(threshold)) || 0;
      log(`[reflection] Created ${newLinksCreated} new links`);
    }

    // ── Graph enrichment: enrich + proximity + communities + centrality ──
    if (idleConfig.operations?.graph_enrichment !== false) {
      const shouldEnrich = newLinksCreated > 0 || memoriesChanged || session.lastLinkCount === undefined;

      if (shouldEnrich) {
        log(`[reflection] Running graph enrichment`);

        // 1. Enrich existing similar_to → semantic relations (LLM)
        try {
          const { enrichExistingLinks } = await import('../lib/graph/llm-relations.js');
          const r = await enrichExistingLinks({ limit: 20, batchSize: 5 });
          log(`[reflection] Enriched ${r.enriched} links (${r.skipped} skipped)`);
        } catch (err) { log(`[reflection] Enrich failed: ${err}`); }

        // 2. Proximity links from co-occurrence
        try {
          const { createProximityLinks } = await import('../lib/graph/contextual-proximity.js');
          const r = await createProximityLinks({ minCooccurrence: 2 });
          log(`[reflection] Created ${r.created} proximity links`);
        } catch (err) { log(`[reflection] Proximity failed: ${err}`); }

        // 3. Community detection + reflection synthesis
        try {
          const { detectCommunities } = await import('../lib/graph/community-detection.js');
          const r = await detectCommunities({ minCommunitySize: 2 });
          log(`[reflection] Found ${r.communities.length} communities`);

          // 3b. Synthesize patterns from community clusters
          if (r.communities.length > 0) {
            try {
              const { synthesizeFromCommunities } = await import('../lib/reflection-synthesizer.js');
              const synthResult = await synthesizeFromCommunities(r, { log });
              if (synthResult.patternsCreated > 0) {
                log(`[reflection] Synthesized ${synthResult.patternsCreated} patterns from ${synthResult.clustersProcessed} clusters`);
              }
            } catch (err) { log(`[reflection] Synthesis failed: ${err}`); }
          }
        } catch (err) { log(`[reflection] Communities failed: ${err}`); }

        // 4. Centrality cache
        try {
          const { updateCentralityCache } = await import('../lib/graph/centrality.js');
          const r = await updateCentralityCache();
          log(`[reflection] Updated centrality for ${r.updated} memories`);
        } catch (err) { log(`[reflection] Centrality failed: ${err}`); }

        session.lastLinkCount = (session.lastLinkCount ?? 0) + newLinksCreated;
      } else {
        log(`[reflection] Skipping graph enrichment (no changes)`);
      }
    }

    // ── Write reflection (runs last, may use LLM) ──
    if (idleConfig.operations?.write_reflection !== false) {
      log(`[reflection] Writing reflection for ${sessionId}`);
      try {
        const progressPath = getProgressFilePath(sessionId);
        const briefingContent = fs.existsSync(progressPath)
          ? fs.readFileSync(progressPath, 'utf-8')
          : briefingResult.briefing || '';

        if (briefingContent.length >= 100) {
          await writeReflection(briefingContent, idleConfig);
          log(`[reflection] Reflection written`);
        }
      } catch (err) {
        log(`[reflection] Write reflection error: ${err}`);
      }
    }

    log(`[reflection] Completed reflection for session ${sessionId}`);
  } catch (err) {
    log(`[reflection] Error for session ${sessionId}: ${err}`);
  }
}

// ============================================================================
// HTTP Request Handler
// ============================================================================

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const reqUrl = new URL(req.url || '/', `http://localhost`);
  const method = req.method || 'GET';

  // CORS headers (for potential web clients)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Parse JSON body for POST requests
  let body: any = null;
  if (method === 'POST') {
    body = await parseBody(req);
  }

  try {
    // Route request
    const result = await routeRequest(method, reqUrl.pathname, reqUrl.searchParams, body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err: any) {
    log(`[http] Error: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

export async function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        logWarn('daemon', 'Invalid JSON in HTTP request body', { error: err instanceof Error ? err.message : String(err) });
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

/** @internal Exported for testing */
export async function routeRequest(method: string, pathname: string, searchParams: URLSearchParams, body: any): Promise<any> {
  // Health check
  if (pathname === '/health') {
    return {
      status: 'ok',
      pid: process.pid,
      uptime: Date.now() - (state?.startedAt || Date.now()),
      activeSessions: sessionManager?.count() || 0,
      cwd: state?.cwd || process.cwd(),
    };
  }

  // Session endpoints
  if (pathname === '/api/session/register' && method === 'POST') {
    const { session_id, transcript_path, is_service = false } = body;
    if (!session_id) {
      throw new ValidationError('session_id required');
    }
    const session = sessionManager!.register(session_id, transcript_path || '', is_service);
    log(`[session] Registered: ${session_id}${is_service ? ' (service)' : ''}`);
    return { success: true, session };
  }

  if (pathname === '/api/session/unregister' && method === 'POST') {
    const { session_id, transcript_path, run_reflection } = body;
    if (!session_id) {
      throw new ValidationError('session_id required');
    }

    const session = sessionManager!.get(session_id);
    const transcriptFile = transcript_path || session?.transcriptPath || '';

    // Flush session counters to learning_deltas before unregister
    try {
      const d = await getStorageDispatcher();
      await d.flushSessionCounters('daemon-session');
    } catch (err) { log(`[session] Failed to flush session counters: ${err}`); }

    // Unregister the session immediately (don't block on processing)
    const removed = sessionManager!.unregister(session_id);
    clearBriefingCache(session_id);  // Clean up any cached briefing
    removeBudget(session_id);  // Clean up token budget
    removeObservations(session_id);  // Clean up observation JSONL
    flushBudgets();
    log(`[session] Unregistered: ${session_id} (removed=${removed})`);

    // Process session asynchronously (summarize transcript, extract learnings, save to memory)
    if (run_reflection && transcriptFile) {
      sessionManager!.incrementPendingWork();
      log(`[session] Queuing async processing for ${session_id}`);

      // Fire-and-forget async processing
      (async () => {
        try {
          const result = await processSessionEnd(transcriptFile, session_id, log);
          log(`[session] Processing complete for ${session_id}: summary=${result.summary.length}chars, learnings=${result.learnings.length}, saved=${result.saved}`);
        } catch (err) {
          log(`[session] Processing failed for ${session_id}: ${err}`);
        } finally {
          sessionManager!.decrementPendingWork();
          // Check shutdown after work completes
          checkShutdown();
        }
      })();
    } else {
      // No processing needed, check shutdown immediately
      checkShutdown();
    }

    return { success: removed, remaining_sessions: sessionManager!.count() };
  }

  if (pathname === '/api/session/activity' && method === 'POST') {
    const { session_id, type, transcript_path, is_service = false } = body;
    if (!session_id || !type) {
      throw new ValidationError('session_id and type required');
    }
    let session = sessionManager!.activity(session_id, type);
    if (!session) {
      // Auto-register if session not found (with transcript_path if provided)
      sessionManager!.register(session_id, transcript_path || '', is_service);
      session = sessionManager!.activity(session_id, type);
      log(`[session] Auto-registered and activity: ${session_id} (${type})${is_service ? ' (service)' : ''}`);
    } else if (transcript_path && !session.transcriptPath) {
      // Update transcript path if not set
      session.transcriptPath = transcript_path;
      log(`[session] Activity: ${session_id} (${type}) + updated transcript`);
    } else {
      log(`[session] Activity: ${session_id} (${type})`);
    }
    return { success: true };
  }

  if (pathname === '/api/sessions' && method === 'GET') {
    const includeService = searchParams.get('includeService') === 'true';
    const sessions: Record<string, SessionState> = {};
    for (const [id, session] of sessionManager!.getAll(includeService)) {
      sessions[id] = session;
    }
    return { sessions, count: sessionManager!.count(includeService) };
  }

  // Search endpoints
  if (pathname === '/api/search' && method === 'POST') {
    const { query, limit = 5, threshold = 0.3 } = body;
    if (!query) {
      throw new ValidationError('query required');
    }
    const queryEmbedding = await getEmbedding(query);
    const results = await hybridSearchDocs(query, queryEmbedding, limit, threshold);

    // Track access for returned memories
    const accesses = results
      .filter((r: any) => r.memory_id)
      .map((r: any) => ({ memoryId: r.memory_id, weight: 0.5 }));
    if (accesses.length > 0) {
      await incrementMemoryAccessBatch(accesses);
    }

    return { results };
  }

  if (pathname === '/api/search-code' && method === 'POST') {
    const { query, limit = 5, threshold = 0.3 } = body;
    if (!query) {
      throw new ValidationError('query required');
    }
    const queryEmbedding = await getEmbedding(query);
    const results = await hybridSearchCode(query, queryEmbedding, limit, threshold);
    return { results };
  }

  if (pathname === '/api/recall' && method === 'POST') {
    const { query, limit = 5 } = body;

    // Empty query returns recent memories
    if (!query) {
      const memories = await getRecentMemories(limit);
      return { results: memories };
    }

    // Generate embedding for semantic search
    const queryEmbedding = await getEmbedding(query);
    const results = await hybridSearchMemories(query, queryEmbedding, limit, 0.3);

    // Track access for returned memories
    const accesses = results
      .filter((r: any) => r.id)
      .map((r: any) => ({ memoryId: r.id, weight: 1.0 }));
    if (accesses.length > 0) {
      await incrementMemoryAccessBatch(accesses);
    }

    return { results };
  }

  if (pathname === '/api/remember' && method === 'POST') {
    const { content, tags = [], type = 'observation', source, global = false, valid_from, valid_until } = body;
    if (!content) {
      throw new ValidationError('content required');
    }

    // In-flight dedup: if an identical request is already being processed, wait for it
    // Prevents race condition when hooks fire twice for the same tool_use
    const contentHash = content.slice(0, 200) + '|' + (tags || []).join(',');
    const existing = rememberInFlight.get(contentHash);
    if (existing) {
      const result = await existing;
      return { success: false, id: result.id, isDuplicate: true, reason: 'in-flight dedup' };
    }

    const processRemember = async () => {
      // Check for sensitive content
      const config = getConfig();
      let finalContent = content;
      if (config.sensitive_filter_enabled !== false) {
        const scanResult = scanSensitive(content);
        if (scanResult.hasSensitive) {
          if (config.sensitive_auto_redact) {
            finalContent = scanResult.redactedText;
          } else {
            throw new ValidationError('Content contains sensitive information');
          }
        }
      }

      // Get embedding
      const embedding = await getEmbedding(finalContent);

      // Score quality
      const qualityResult = await scoreMemory(finalContent);
      if (!passesQualityThreshold(qualityResult)) {
        return { success: false, reason: 'Below quality threshold', score: qualityResult.score };
      }

      // Save to appropriate DB
      let result;
      if (global) {
        result = await saveGlobalMemory(finalContent, embedding, tags, type);
      } else {
        result = await saveMemory(finalContent, embedding, tags, source ?? type, {
          qualityScore: { score: qualityResult.score, factors: qualityResult.factors },
          validFrom: valid_from,
          validUntil: valid_until,
        });
      }

      return { success: !result.isDuplicate, id: result.id, isDuplicate: result.isDuplicate };
    };

    const promise = processRemember();
    rememberInFlight.set(contentHash, promise);
    setTimeout(() => rememberInFlight.delete(contentHash), REMEMBER_DEDUP_TTL_MS);

    try {
      return await promise;
    } finally {
      rememberInFlight.delete(contentHash);
    }
  }

  // Reflection endpoint
  if (pathname === '/api/reflect' && method === 'POST') {
    const { session_id } = body;
    const watcherConfig = getIdleWatcherConfig();

    if (session_id) {
      const session = sessionManager!.get(session_id);
      if (!session) {
        throw new NotFoundError('Session not found');
      }
      await handleReflection(session_id, session);
      sessionManager!.markReflection(session_id);
      return { success: true, session_id };
    } else {
      // Run for all idle sessions
      const idleSessions = sessionManager!.getIdleSessions(watcherConfig.idle_minutes);
      for (const { sessionId, session } of idleSessions) {
        await handleReflection(sessionId, session);
        sessionManager!.markReflection(sessionId);
      }
      return { success: true, sessions_processed: idleSessions.length };
    }
  }

  // Compact briefing endpoint (for /compact hook)
  // Supports pre-generated cache for instant responses
  if (pathname === '/api/briefing' && method === 'POST') {
    const { transcript, transcript_path, session_id, format, model, include_learnings, include_memories, max_memories, use_cache } = body;

    // Try cached briefing first if session_id provided and use_cache not explicitly false
    if (session_id && use_cache !== false) {
      const cached = briefingCache.get(session_id);
      if (cached) {
        const age = Date.now() - cached.generatedAt;
        if (age < BRIEFING_CACHE_MAX_AGE_MS) {
          log(`[briefing] Serving cached briefing for ${session_id.slice(0, 8)} (age: ${Math.round(age / 1000)}s)`);
          return { success: true, briefing: cached.briefing, cached: true };
        }
      }
    }

    // Either transcript content or path to transcript file
    let transcriptContent: string;
    if (transcript) {
      transcriptContent = transcript;
    } else if (transcript_path && fs.existsSync(transcript_path)) {
      transcriptContent = fs.readFileSync(transcript_path, 'utf-8');
    } else {
      throw new ValidationError('transcript or transcript_path required');
    }

    const result = await generateCompactBriefing(transcriptContent, {
      format,
      include_learnings,
      include_memories,
      max_memories,
    });

    // Cache the result if session_id provided
    if (session_id && result.success && result.briefing && transcript_path) {
      const stats = fs.existsSync(transcript_path) ? fs.statSync(transcript_path) : null;
      briefingCache.set(session_id, {
        briefing: result.briefing,
        generatedAt: Date.now(),
        transcriptSize: stats?.size || 0,
      });
    }

    return { ...result, cached: false };
  }

  // Status endpoints
  if (pathname === '/api/status' && method === 'GET') {
    const stats = await getStats();
    const memStats = await getMemoryStats();
    const watchStatus = getWatcherStatus();
    const analyzeStatus = getAnalyzerStatus();
    return {
      daemon: {
        pid: process.pid,
        uptime: Date.now() - (state?.startedAt || Date.now()),
        sessions: sessionManager!.count(),
      },
      index: stats,
      memories: memStats,
      services: {
        watch: watchStatus,
        analyze: analyzeStatus,
      },
    };
  }

  // Watch service endpoints
  if (pathname === '/api/watch/start' && method === 'POST') {
    const { patterns, includeCode } = body;
    const watchState = await startWatcher(
      { patterns, includeCode },
      log
    );
    return {
      success: true,
      active: watchState.active,
      patterns: watchState.patterns,
      includeCode: watchState.includeCode,
    };
  }

  if (pathname === '/api/watch/stop' && method === 'POST') {
    await stopWatcher(log);
    return { success: true };
  }

  if (pathname === '/api/watch/status' && method === 'GET') {
    return getWatcherStatus();
  }

  if (pathname === '/api/watch/index' && method === 'POST') {
    const { file } = body;
    if (!file) {
      throw new ValidationError('file required');
    }
    await indexFileOnDemand(file, log);
    return { success: true, file };
  }

  // Analyze service endpoints
  if (pathname === '/api/analyze/start' && method === 'POST') {
    const { intervalMinutes, mode } = body;
    const analyzeState = startAnalyzer(
      { intervalMinutes, mode },
      log
    );
    return {
      success: true,
      active: analyzeState.active,
      runsCompleted: analyzeState.runsCompleted,
    };
  }

  if (pathname === '/api/analyze/stop' && method === 'POST') {
    stopAnalyzer(log);
    return { success: true };
  }

  if (pathname === '/api/analyze/status' && method === 'GET') {
    return getAnalyzerStatus();
  }

  if (pathname === '/api/analyze' && method === 'POST') {
    const { mode = 'claude' } = body;
    await triggerAnalysis(mode, log);
    return { success: true };
  }

  // Skills endpoints
  if (pathname === '/api/skills/suggest' && method === 'POST') {
    const { prompt, limit = 2 } = body;
    if (!prompt) {
      throw new ValidationError('prompt required');
    }

    const { suggestSkills, getSkillsConfig } = await import('../lib/skills.js');
    const config = getSkillsConfig();

    if (!config.enabled || !config.auto_suggest?.enabled) {
      return { success: true, skills: [], disabled: true };
    }

    const suggestions = await suggestSkills(prompt, config);
    return {
      success: true,
      skills: suggestions.slice(0, limit),
    };
  }

  if (pathname === '/api/skills/index' && method === 'POST') {
    const { indexLocalSkills } = await import('../lib/skills.js');
    const cwd = state?.cwd || process.cwd();
    const count = indexLocalSkills(cwd);
    return { success: true, indexed: count };
  }

  if (pathname === '/api/skills/track' && method === 'POST') {
    const { skill_name } = body;
    if (!skill_name) {
      throw new ValidationError('skill_name required');
    }

    const { trackSkillUsage } = await import('../lib/skills.js');
    trackSkillUsage(skill_name);
    return { success: true };
  }

  // Skyll status endpoint
  if (pathname === '/api/skills/skyll' && method === 'GET') {
    const { getSkyllStatus } = await import('../lib/skyll-client.js');
    return getSkyllStatus();
  }

  // Services endpoint (list all services status)
  if (pathname === '/api/services' && method === 'GET') {
    return {
      watch: getWatcherStatus(),
      analyze: getAnalyzerStatus(),
      idle: {
        enabled: true,
        sessions: sessionManager!.count(),
      },
    };
  }

  throw new NotFoundError(`Unknown endpoint: ${method} ${pathname}`);
}

// ============================================================================
// Daemon Lifecycle
// ============================================================================

export async function startDaemon(): Promise<{ port: number; pid: number }> {
  if (state?.server) {
    return { port: state.port, pid: process.pid };
  }

  // Check if another daemon is already running (prevent duplicate processes)
  const existingPidFile = getDaemonPidFile();
  if (fs.existsSync(existingPidFile)) {
    try {
      const existingPid = parseInt(fs.readFileSync(existingPidFile, 'utf8').trim(), 10);
      if (existingPid && existingPid !== process.pid) {
        // Check if process is actually running
        try {
          process.kill(existingPid, 0); // Signal 0 = check if process exists
          // Process exists, read port and return
          const portFile = getDaemonPortFile();
          if (fs.existsSync(portFile)) {
            const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
            log(`[daemon] Another daemon already running (pid=${existingPid}, port=${port})`);
            process.exit(0); // Exit silently - another daemon is handling things
          }
        } catch {
          // Process doesn't exist, clean up stale files
          log(`[daemon] Cleaning up stale PID file (pid=${existingPid} not running)`);
          fs.unlinkSync(existingPidFile);
          const portFile = getDaemonPortFile();
          if (fs.existsSync(portFile)) {
            fs.unlinkSync(portFile);
          }
        }
      }
    } catch (err) {
      logWarn('daemon', 'Failed to read daemon PID file', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const cwd = getProjectRoot();
  const watcherConfig = getIdleWatcherConfig();
  const idleConfig = getIdleReflectionConfig();

  // Initialize storage dispatcher (routes to SQLite or PG based on config)
  await initStorageDispatcher();

  // Initialize session manager
  sessionManager = createSessionManager();

  // Load token budgets from previous daemon run
  loadBudgets();

  // Clean up stale observation files (>48h)
  cleanupStaleObservations();

  // Create HTTP server
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log(`[http] Unhandled error: ${err.message}`);
      res.writeHead(500);
      res.end();
    });
  });

  // Find available port
  const portStart = DEFAULT_PORT_RANGE_START;
  let port = portStart;

  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', (err: any) => {
          if (err.code === 'EADDRINUSE') {
            port++;
            resolve();
          } else {
            reject(err);
          }
        });
        server.listen(port, '127.0.0.1', () => {
          resolve();
        });
      });

      if (server.listening) {
        break;
      }
    } catch (err) {
      throw err;
    }
  }

  if (!server.listening) {
    throw new NetworkError(`Could not find available port in range ${portStart}-${portStart + MAX_PORT_ATTEMPTS}`);
  }

  // Save state
  state = {
    cwd,
    startedAt: Date.now(),
    port,
    server,
  };

  // Write PID and port files
  fs.writeFileSync(getDaemonPidFile(), String(process.pid));
  fs.writeFileSync(getDaemonPortFile(), String(port));

  // Start idle watcher with briefing pre-generation
  idleWatcher = createIdleWatcher({
    sessionManager,
    onIdle: handleReflection,
    onPreGenerateBriefing: preGenerateBriefing,
    checkIntervalSeconds: watcherConfig.check_interval,
    idleMinutes: watcherConfig.idle_minutes,
    reflectionCooldownMinutes: watcherConfig.reflection_cooldown_minutes,
    preGenerateIdleSeconds: 120,  // Pre-generate briefing after 2 min idle
    log,
  });
  idleWatcher.start();

  log(`[daemon] Started on port ${port} (pid=${process.pid})`);

  // Auto-start watch service if configured
  const config = getConfig();
  if (config.daemon?.watch?.auto_start) {
    const watchConfig = config.daemon.watch;
    await startWatcher(
      {
        patterns: watchConfig.patterns || ['**/*.md'],
        includeCode: watchConfig.include_code ?? false,
        debounceMs: watchConfig.debounce_ms ?? 500,
      },
      log
    );
    log(`[daemon] Auto-started watch service`);
  }

  // Auto-start analyze service if configured
  if (config.daemon?.analyze?.auto_start) {
    const analyzeConfig = config.daemon.analyze;
    startAnalyzer(
      {
        intervalMinutes: analyzeConfig.interval_minutes ?? 30,
        mode: analyzeConfig.mode ?? 'claude',
      },
      log
    );
    log(`[daemon] Auto-started analyze service`);
  }

  // Setup graceful shutdown
  setupShutdownHandlers();

  return { port, pid: process.pid };
}

function setupShutdownHandlers(): void {
  const shutdown = () => shutdownDaemon();

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // SIGHUP only exists on Unix
  if (process.platform !== 'win32') {
    process.on('SIGHUP', shutdown);
  }
}

/**
 * Check if daemon should shutdown (no sessions and no pending work)
 */
function checkShutdown(): void {
  if (sessionManager?.canShutdown()) {
    log(`[daemon] No more sessions and no pending work, scheduling shutdown`);
    setTimeout(() => {
      if (sessionManager?.canShutdown()) {
        shutdownDaemon();
      }
    }, 5000); // Give 5 seconds for new sessions to connect
  }
}

export function shutdownDaemon(): void {
  log('[daemon] Shutting down...');

  // Stop idle watcher
  if (idleWatcher) {
    idleWatcher.stop();
    idleWatcher = null;
  }

  // Stop watch service (async, but we're shutting down so fire-and-forget)
  stopWatcher(log).catch(err => log(`[shutdown] Watcher stop failed: ${err}`));

  // Stop analyze service
  stopAnalyzer(log);

  // Close HTTP server
  if (state?.server) {
    state.server.close();
    state.server = null;
  }

  // Cleanup DB connections
  closeStorageDispatcher().catch(err => log(`[shutdown] Storage close failed: ${err}`));
  cleanupEmbeddings();
  cleanupQualityScoring();
  closeDb();
  closeGlobalDb();

  // Remove PID and port files
  try {
    fs.unlinkSync(getDaemonPidFile());
  } catch (err: any) {
    if (err.code !== 'ENOENT') log(`[shutdown] PID file removal failed: ${err}`);
  }
  try {
    fs.unlinkSync(getDaemonPortFile());
  } catch (err: any) {
    if (err.code !== 'ENOENT') log(`[shutdown] Port file removal failed: ${err}`);
  }

  log('[daemon] Shutdown complete');
  process.exit(0);
}

// ============================================================================
// Test Helpers (exported for unit testing)
// ============================================================================

/** @internal Initialize module state for testing without starting HTTP server */
export function _initTestState(cwd: string = process.cwd()): void {
  sessionManager = createSessionManager();
  state = { cwd, startedAt: Date.now(), port: 0, server: null };
}

/** @internal Reset module state after testing */
export function _resetTestState(): void {
  sessionManager = null;
  idleWatcher = null;
  state = null;
  briefingCache.clear();
  briefingGenerationInProgress.clear();
}

// ============================================================================
// CLI Entry Point
// ============================================================================

// If run directly, start daemon
if (process.argv[1]?.endsWith('service.js') || process.argv[1]?.endsWith('service.ts')) {
  startDaemon()
    .then(({ port, pid }) => {
      console.log(`Daemon started on port ${port} (pid=${pid})`);
    })
    .catch((err) => {
      logError('daemon', `Failed to start daemon: ${err.message}`, err);
      console.error('Failed to start daemon:', err.message);
      process.exit(1);
    });
}

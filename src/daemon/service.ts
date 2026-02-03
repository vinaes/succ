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
import { processSessionEnd } from './session-processor.js';
import { startWatcher, stopWatcher, getWatcherStatus, indexFileOnDemand } from './watcher.js';
import { startAnalyzer, stopAnalyzer, getAnalyzerStatus, triggerAnalysis } from './analyzer.js';
import { getProjectRoot, getSuccDir, getIdleReflectionConfig, getIdleWatcherConfig, getConfig } from '../lib/config.js';
import {
  hybridSearchDocs,
  hybridSearchCode,
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
} from '../lib/db.js';
import { getEmbedding, cleanupEmbeddings } from '../lib/embeddings.js';
import { scoreMemory, passesQualityThreshold, cleanupQualityScoring } from '../lib/quality.js';
import { scanSensitive } from '../lib/sensitive-filter.js';
import { extractSessionSummary } from '../lib/session-summary.js';
import { generateCompactBriefing } from '../lib/compact-briefing.js';
import spawn from 'cross-spawn';

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
function appendToProgressFile(sessionId: string, briefing: string): void {
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
function readTailTranscript(transcriptPath: string, maxBytes: number = 2 * 1024 * 1024): string {
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
  } catch {
    // Ignore log write errors
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

  const prompt = `You are writing a brief personal reflection for an AI's internal journal.

Session context (recent conversation):
---
${transcript.substring(0, 3000)}
---

Write a short reflection (3-5 sentences) about this session. Be honest and introspective.
Consider:
- What was accomplished or attempted?
- Any interesting challenges or discoveries?
- What might be worth remembering for future sessions?

Output ONLY the reflection text, no headers or formatting. Write in first person as if you are the AI reflecting on your own work.`;

  let reflectionText: string | null = null;

  // Use sleep_agent if enabled (write_reflection is a good candidate for local LLM)
  const sleepAgent = idleConfig.sleep_agent;
  const useSleepAgent = sleepAgent?.enabled && sleepAgent?.model;

  if (useSleepAgent) {
    // Use local LLM via sleep_agent
    reflectionText = await callSleepAgent(prompt, sleepAgent);
  } else {
    // Use Claude CLI
    const claudeModel = idleConfig.agent_model || 'haiku';
    reflectionText = await callClaudeCLI(prompt, claudeModel);
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
  saveMemory(reflectionText.trim(), embedding, ['reflection'], 'observation', {
    qualityScore: { score: 0.6, factors: { hasContext: 1 } },
  });
}

/**
 * Call Claude CLI to generate text
 */
function callClaudeCLI(prompt: string, model: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['-p', '--tools', '', '--model', model], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SUCC_SERVICE_SESSION: '1' },
      windowsHide: true, // Hide CMD window on Windows (works without detached)
    });

    proc.stdin?.write(prompt);
    proc.stdin?.end();

    let stdout = '';
    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on('close', (code: number | null) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => resolve(null));

    // Timeout after 60 seconds
    setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 60000);
  });
}

/**
 * Call sleep agent (local LLM) via OpenAI-compatible API
 */
async function callSleepAgent(
  prompt: string,
  sleepAgent: NonNullable<ReturnType<typeof getIdleReflectionConfig>['sleep_agent']>
): Promise<string | null> {
  const { mode, model, api_url, api_key } = sleepAgent;

  let baseUrl = api_url;
  if (!baseUrl) {
    if (mode === 'local') baseUrl = 'http://localhost:11434/v1';
    else if (mode === 'openrouter') baseUrl = 'https://openrouter.ai/api/v1';
  }
  if (!baseUrl) return null;

  const endpoint = baseUrl.endsWith('/')
    ? `${baseUrl}chat/completions`
    : `${baseUrl}/chat/completions`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (api_key) headers['Authorization'] = `Bearer ${api_key}`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || 'qwen2.5-coder:14b',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 1000,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

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
    // Generate briefing and append to progress file
    // Read only tail of transcript to avoid OOM on 70MB+ files
    // compact-briefing internally limits to ~6000 chars anyway
    const transcriptContent = readTailTranscript(session.transcriptPath, 100 * 1024); // 100KB max

    const briefingResult = await generateCompactBriefing(transcriptContent, {
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

    // Run independent operations in parallel for better performance
    const globalConfig = getConfig();
    const parallelOps: Promise<void>[] = [];

    // NOTE: session_summary and precompute_context moved to processSessionEnd()
    // They now run at session end using the progress file instead of parsing full transcript

    // memory_consolidation - independent
    if (idleConfig.operations?.memory_consolidation !== false) {
      parallelOps.push((async () => {
        log(`[reflection] Running memory consolidation`);
        const { consolidate } = await import('../commands/consolidate.js');
        const threshold = idleConfig.thresholds?.similarity_for_merge ?? 0.85;
        const limit = idleConfig.max_memories_to_process ?? 50;
        await consolidate({
          threshold: String(threshold),
          limit: String(limit),
          verbose: false,
        });
        log(`[reflection] Memory consolidation complete`);
      })());
    }

    // retention_cleanup - independent
    if (globalConfig.retention?.enabled && idleConfig.operations?.retention_cleanup !== false) {
      parallelOps.push((async () => {
        log(`[reflection] Running retention cleanup`);
        const { retention } = await import('../commands/retention.js');
        await retention({ apply: true, verbose: false });
        log(`[reflection] Retention cleanup complete`);
      })());
    }

    // Wait for all parallel operations
    await Promise.all(parallelOps);

    // graph_refinement - depends on consolidation completing first
    if (idleConfig.operations?.graph_refinement !== false) {
      log(`[reflection] Running graph auto-link`);
      const threshold = idleConfig.thresholds?.auto_link_threshold ?? 0.75;
      const linksCreated = autoLinkSimilarMemories(threshold);
      log(`[reflection] Created ${linksCreated} new links`);
    }

    // write_reflection - runs last (may use LLM)
    // Note: uses briefing from progress file, not full transcript parsing
    if (idleConfig.operations?.write_reflection !== false) {
      log(`[reflection] Writing reflection for ${sessionId}`);
      try {
        // Read briefing from progress file for reflection
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

async function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

async function routeRequest(method: string, pathname: string, searchParams: URLSearchParams, body: any): Promise<any> {
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
      throw new Error('session_id required');
    }
    const session = sessionManager!.register(session_id, transcript_path || '', is_service);
    log(`[session] Registered: ${session_id}${is_service ? ' (service)' : ''}`);
    return { success: true, session };
  }

  if (pathname === '/api/session/unregister' && method === 'POST') {
    const { session_id, transcript_path, run_reflection } = body;
    if (!session_id) {
      throw new Error('session_id required');
    }

    const session = sessionManager!.get(session_id);
    const transcriptFile = transcript_path || session?.transcriptPath || '';

    // Unregister the session immediately (don't block on processing)
    const removed = sessionManager!.unregister(session_id);
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
      throw new Error('session_id and type required');
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
      throw new Error('query required');
    }
    const results = hybridSearchDocs(query, limit, threshold);

    // Track access for returned memories
    const accesses = results
      .filter((r: any) => r.memory_id)
      .map((r: any) => ({ memoryId: r.memory_id, weight: 0.5 }));
    if (accesses.length > 0) {
      incrementMemoryAccessBatch(accesses);
    }

    return { results };
  }

  if (pathname === '/api/search-code' && method === 'POST') {
    const { query, limit = 5 } = body;
    if (!query) {
      throw new Error('query required');
    }
    const results = hybridSearchCode(query, limit);
    return { results };
  }

  if (pathname === '/api/recall' && method === 'POST') {
    const { query, limit = 5 } = body;

    // Empty query returns recent memories
    if (!query) {
      const memories = getRecentMemories(limit);
      return { results: memories };
    }

    // Use hybridSearchDocs for memories (they're indexed there)
    const results = hybridSearchDocs(query, limit, 0.3);

    // Track access for returned memories
    const accesses = results
      .filter((r: any) => r.memory_id)
      .map((r: any) => ({ memoryId: r.memory_id, weight: 1.0 }));
    if (accesses.length > 0) {
      incrementMemoryAccessBatch(accesses);
    }

    return { results };
  }

  if (pathname === '/api/remember' && method === 'POST') {
    const { content, tags = [], type = 'observation', global = false, valid_from, valid_until } = body;
    if (!content) {
      throw new Error('content required');
    }

    // Check for sensitive content
    const config = getConfig();
    let finalContent = content;
    if (config.sensitive_filter_enabled !== false) {
      const scanResult = scanSensitive(content);
      if (scanResult.hasSensitive) {
        if (config.sensitive_auto_redact) {
          finalContent = scanResult.redactedText;
        } else {
          throw new Error('Content contains sensitive information');
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
      // Global memory has simpler signature (no quality score, no temporal)
      result = saveGlobalMemory(finalContent, embedding, tags, type);
    } else {
      result = saveMemory(finalContent, embedding, tags, type, {
        qualityScore: { score: qualityResult.score, factors: qualityResult.factors },
        validFrom: valid_from,
        validUntil: valid_until,
      });
    }

    return { success: !result.isDuplicate, id: result.id, isDuplicate: result.isDuplicate };
  }

  // Reflection endpoint
  if (pathname === '/api/reflect' && method === 'POST') {
    const { session_id } = body;
    const watcherConfig = getIdleWatcherConfig();

    if (session_id) {
      const session = sessionManager!.get(session_id);
      if (!session) {
        throw new Error('Session not found');
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
  if (pathname === '/api/briefing' && method === 'POST') {
    const { transcript, transcript_path, format, model, include_learnings, include_memories, max_memories } = body;

    // Either transcript content or path to transcript file
    let transcriptContent: string;
    if (transcript) {
      transcriptContent = transcript;
    } else if (transcript_path && fs.existsSync(transcript_path)) {
      transcriptContent = fs.readFileSync(transcript_path, 'utf-8');
    } else {
      throw new Error('transcript or transcript_path required');
    }

    const result = await generateCompactBriefing(transcriptContent, {
      format,
      model,
      include_learnings,
      include_memories,
      max_memories,
    });

    return result;
  }

  // Status endpoints
  if (pathname === '/api/status' && method === 'GET') {
    const stats = getStats();
    const memStats = getMemoryStats();
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
      throw new Error('file required');
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

  throw new Error(`Unknown endpoint: ${method} ${pathname}`);
}

// ============================================================================
// Daemon Lifecycle
// ============================================================================

export async function startDaemon(): Promise<{ port: number; pid: number }> {
  if (state?.server) {
    return { port: state.port, pid: process.pid };
  }

  const cwd = getProjectRoot();
  const watcherConfig = getIdleWatcherConfig();
  const idleConfig = getIdleReflectionConfig();

  // Initialize session manager
  sessionManager = createSessionManager();

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
    throw new Error(`Could not find available port in range ${portStart}-${portStart + MAX_PORT_ATTEMPTS}`);
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

  // Start idle watcher
  idleWatcher = createIdleWatcher({
    sessionManager,
    onIdle: handleReflection,
    checkIntervalSeconds: watcherConfig.check_interval,
    idleMinutes: watcherConfig.idle_minutes,
    reflectionCooldownMinutes: watcherConfig.reflection_cooldown_minutes,
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
  stopWatcher(log).catch(() => {});

  // Stop analyze service
  stopAnalyzer(log);

  // Close HTTP server
  if (state?.server) {
    state.server.close();
    state.server = null;
  }

  // Cleanup DB connections
  cleanupEmbeddings();
  cleanupQualityScoring();
  closeDb();
  closeGlobalDb();

  // Remove PID and port files
  try {
    fs.unlinkSync(getDaemonPidFile());
  } catch {}
  try {
    fs.unlinkSync(getDaemonPortFile());
  } catch {}

  log('[daemon] Shutdown complete');
  process.exit(0);
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
      console.error('Failed to start daemon:', err.message);
      process.exit(1);
    });
}

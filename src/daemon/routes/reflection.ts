import fs from 'fs';
import path from 'path';

import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { getEmbedding } from '../../lib/embeddings.js';
import {
  getConfig,
  getIdleReflectionConfig,
  getIdleWatcherConfig,
  getObserverConfig,
  getProjectRoot,
} from '../../lib/config.js';
import { generateCompactBriefing } from '../../lib/compact-briefing.js';
import { extractSessionSummary } from '../../lib/session-summary.js';
import { callLLM } from '../../lib/llm.js';
import { getMemoryStats, saveMemory } from '../../lib/storage/index.js';
import {
  flushBudgets,
  recordExtraction,
  recordTranscriptTokens,
  resetTranscriptCounter,
} from '../../lib/token-budget.js';
import {
  appendObservations,
  cleanupStaleObservations,
  removeObservations,
} from '../../lib/session-observations.js';
import { REFLECTION_PROMPT, REFLECTION_SYSTEM } from '../../prompts/index.js';
import type { SessionState } from '../sessions.js';
import {
  parseRequestBody,
  ReflectBodySchema,
  BriefingBodySchema,
  requireSessionManager,
  type RouteContext,
  type RouteMap,
} from './types.js';

interface BriefingCache {
  briefing: string;
  generatedAt: number;
  transcriptSize: number;
}

const briefingCache = new Map<string, BriefingCache>();
const briefingGenerationInProgress = new Set<string>();

const BRIEFING_CACHE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const BRIEFING_MIN_TRANSCRIPT_GROWTH = 5000; // Re-generate after 5KB growth

export function resetReflectionRoutesState(): void {
  briefingCache.clear();
  briefingGenerationInProgress.clear();
}

export function clearBriefingCache(sessionId: string): void {
  briefingCache.delete(sessionId);
  briefingGenerationInProgress.delete(sessionId);
}

async function writeReflection(
  transcript: string,
  _idleConfig: ReturnType<typeof getIdleReflectionConfig>,
  log: (message: string) => void
): Promise<void> {
  const projectRoot = getProjectRoot();
  const reflectionsDir = path.join(projectRoot, '.succ', 'brain', 'reflections');

  if (!fs.existsSync(reflectionsDir)) {
    fs.mkdirSync(reflectionsDir, { recursive: true });
  }

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0].substring(0, 5);
  const timestamp = `${dateStr} ${timeStr}`;

  const prompt = REFLECTION_PROMPT.replace('{transcript}', transcript.substring(0, 3000));

  let reflectionText: string | null = null;
  try {
    reflectionText = await callLLM(prompt, {
      timeout: 60000,
      useSleepAgent: true,
      systemPrompt: REFLECTION_SYSTEM,
    });
  } catch (err) {
    log(`[reflection] LLM call failed: ${err}`);
    reflectionText = null;
  }

  if (!reflectionText || reflectionText.trim().length < 50) {
    log(`[reflection] Reflection text too short or empty, skipping`);
    return;
  }

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

  const embedding = await getEmbedding(reflectionText.trim());
  await saveMemory(reflectionText.trim(), embedding, ['reflection'], 'observation', {
    qualityScore: { score: 0.6, factors: { hasContext: 1 } },
    deduplicate: true,
  });
}

export async function preGenerateBriefing(
  ctx: RouteContext,
  sessionId: string,
  transcriptPath: string
): Promise<void> {
  if (briefingGenerationInProgress.has(sessionId)) {
    return;
  }

  if (!fs.existsSync(transcriptPath)) {
    return;
  }

  const stats = fs.statSync(transcriptPath);
  const currentSize = stats.size;

  const cached = briefingCache.get(sessionId);
  if (cached) {
    const age = Date.now() - cached.generatedAt;
    const growth = currentSize - cached.transcriptSize;
    if (age < BRIEFING_CACHE_MAX_AGE_MS && growth < BRIEFING_MIN_TRANSCRIPT_GROWTH) {
      return;
    }
  }

  briefingGenerationInProgress.add(sessionId);
  ctx.log(`[briefing] Pre-generating for session ${sessionId.slice(0, 8)}...`);

  try {
    const transcriptContent = fs.readFileSync(transcriptPath, 'utf-8');
    const result = await generateCompactBriefing(transcriptContent);

    if (result.success && result.briefing) {
      briefingCache.set(sessionId, {
        briefing: result.briefing,
        generatedAt: Date.now(),
        transcriptSize: currentSize,
      });
      ctx.log(
        `[briefing] Pre-generated for session ${sessionId.slice(0, 8)} (${result.briefing.length} chars)`
      );
    } else {
      ctx.log(`[briefing] Pre-generation failed: ${result.error}`);
    }
  } catch (error) {
    ctx.log(`[briefing] Pre-generation error: ${error}`);
  } finally {
    briefingGenerationInProgress.delete(sessionId);
  }
}

export async function performReflection(
  ctx: RouteContext,
  sessionId: string,
  session: SessionState
): Promise<void> {
  if (session.isService) {
    ctx.log(`[reflection] Skipping service session ${sessionId}`);
    return;
  }

  ctx.log(`[reflection] Starting reflection for session ${sessionId}`);

  const idleConfig = getIdleReflectionConfig();

  if (!session.transcriptPath || !fs.existsSync(session.transcriptPath)) {
    ctx.log(`[reflection] No transcript found for session ${sessionId}`);
    return;
  }

  try {
    let transcriptChanged = true;
    let memoriesChanged = true;

    try {
      const currentSize = fs.statSync(session.transcriptPath).size;
      if (session.lastTranscriptSize !== undefined && currentSize === session.lastTranscriptSize) {
        transcriptChanged = false;
        ctx.log(`[reflection] Transcript unchanged (${currentSize}b), skipping briefing`);
      }
      session.lastTranscriptSize = currentSize;
    } catch (error) {
      ctx.log(`[reflection] Failed to stat transcript file for size check: ${error}`);
    }

    const memStats = await getMemoryStats();
    const currentMemCount = memStats.total;
    if (session.lastMemoryCount !== undefined && currentMemCount === session.lastMemoryCount) {
      memoriesChanged = false;
    }
    session.lastMemoryCount = currentMemCount;

    const observerConfig = getObserverConfig();
    if (observerConfig.enabled && transcriptChanged) {
      try {
        const currentSize = session.lastTranscriptSize ?? 0;
        const lastObsSize = session.lastObservationSize ?? 0;
        const lastObsTime = session.lastObservation ?? session.registeredAt;
        const now = Date.now();

        const newBytes = currentSize - lastObsSize;
        const timeThresholdMs = observerConfig.max_minutes * 60 * 1000;
        const enoughTime = now - lastObsTime >= timeThresholdMs;

        const estimatedTokens = Math.ceil(newBytes / 3.5);
        const enoughNewContent = estimatedTokens >= observerConfig.min_tokens;

        if (enoughNewContent || enoughTime) {
          const newContent = ctx.readTailTranscript(session.transcriptPath, newBytes);
          const realTokens = recordTranscriptTokens(sessionId, newContent);
          ctx.log(
            `[observer] Triggering extraction (tokens: ~${realTokens}, time: ${Math.round((now - lastObsTime) / 60000)}min)`
          );

          if (newContent.length > 200) {
            const result = await extractSessionSummary(newContent, { verbose: false });
            recordExtraction(
              sessionId,
              result.transcriptTokens ?? 0,
              result.summaryTokens ?? 0,
              result.factsExtracted,
              result.factsSaved
            );
            resetTranscriptCounter(sessionId);

            if (result.factsSaved > 0) {
              appendObservations(sessionId, [
                {
                  content: `Extracted ${result.factsExtracted} facts, saved ${result.factsSaved}`,
                  type: 'observation',
                  tags: ['mid-session'],
                  extractedAt: new Date().toISOString(),
                  source: 'mid-session-observer',
                  transcriptOffset: currentSize,
                  memoryId: null,
                },
              ]);
            }
            ctx.log(
              `[observer] Extracted ${result.factsExtracted} facts, saved ${result.factsSaved} (skipped ${result.factsSkipped})`
            );
          }

          session.lastObservation = now;
          session.lastObservationSize = currentSize;
          flushBudgets();
        }
      } catch (err) {
        ctx.log(`[observer] Mid-session extraction failed: ${err}`);
      }
    }

    let briefingResult: { success: boolean; briefing?: string } = { success: false };

    if (transcriptChanged) {
      const transcriptContent = ctx.readTailTranscript(session.transcriptPath, 100 * 1024);
      briefingResult = await generateCompactBriefing(transcriptContent, {
        format: 'structured',
        include_memories: true,
        max_memories: 3,
      });

      if (briefingResult.success && briefingResult.briefing) {
        ctx.appendToProgressFile(sessionId, briefingResult.briefing);
        ctx.log(
          `[reflection] Appended briefing to progress file (${briefingResult.briefing.length} chars)`
        );
      } else {
        ctx.log(`[reflection] Failed to generate briefing for ${sessionId}`);
      }
    }

    const globalConfig = getConfig();
    const parallelOps: Promise<void>[] = [];

    if (memoriesChanged && idleConfig.operations?.memory_consolidation === true) {
      parallelOps.push(
        (async () => {
          const threshold = idleConfig.thresholds?.similarity_for_merge ?? 0.92;
          const limit = idleConfig.max_memories_to_process ?? 50;

          ctx.log(
            `[reflection] Running memory consolidation (threshold=${threshold}, limit=${limit})`
          );
          const { consolidate } = await import('../../commands/consolidate.js');
          await consolidate({
            threshold: String(threshold),
            limit: String(limit),
            llm: true,
            verbose: false,
          });
          ctx.log(`[reflection] Memory consolidation complete`);
        })()
      );
    }

    if (globalConfig.retention?.enabled && idleConfig.operations?.retention_cleanup !== false) {
      parallelOps.push(
        (async () => {
          ctx.log(`[reflection] Running retention cleanup`);
          const { retention } = await import('../../commands/retention.js');
          await retention({ apply: true, verbose: false });
          ctx.log(`[reflection] Retention cleanup complete`);
        })()
      );
    }

    await Promise.all(parallelOps);

    if (
      idleConfig.operations?.graph_refinement !== false ||
      idleConfig.operations?.graph_enrichment !== false
    ) {
      const shouldRun = memoriesChanged || session.lastLinkCount === undefined;

      if (shouldRun) {
        ctx.log(`[reflection] Running graph cleanup pipeline`);

        try {
          const { graphCleanup } = await import('../../lib/graph/cleanup.js');
          const cleanupResult = await graphCleanup({
            skipEnrich: idleConfig.operations?.graph_enrichment === false,
            onProgress: (step, detail) => ctx.log(`[reflection] [${step}] ${detail}`),
          });
          ctx.log(
            `[reflection] Cleanup: pruned ${cleanupResult.pruned}, enriched ${cleanupResult.enriched}, orphans ${cleanupResult.orphansConnected}, communities ${cleanupResult.communitiesDetected}, centrality ${cleanupResult.centralityUpdated}`
          );

          try {
            const { createProximityLinks } =
              await import('../../lib/graph/contextual-proximity.js');
            const result = await createProximityLinks({ minCooccurrence: 2 });
            ctx.log(`[reflection] Created ${result.created} proximity links`);
          } catch (err) {
            ctx.log(`[reflection] Proximity failed: ${err}`);
          }

          if (
            cleanupResult.communityResult &&
            cleanupResult.communityResult.communities.length > 0
          ) {
            try {
              const { synthesizeFromCommunities } =
                await import('../../lib/reflection-synthesizer.js');
              const synthResult = await synthesizeFromCommunities(cleanupResult.communityResult, {
                log: ctx.log,
              });
              const hasSynthActivity =
                synthResult.patternsCreated > 0 ||
                synthResult.duplicatesSkipped > 0 ||
                synthResult.reinforced > 0;
              if (hasSynthActivity) {
                ctx.log(
                  `[reflection] Synthesized ${synthResult.patternsCreated} patterns from ${synthResult.clustersProcessed} clusters` +
                    (synthResult.reinforced > 0
                      ? `, reinforced ${synthResult.reinforced} existing`
                      : '') +
                    (synthResult.duplicatesSkipped > 0
                      ? `, skipped ${synthResult.duplicatesSkipped} duplicates`
                      : '') +
                    (synthResult.observationsMarked > 0
                      ? `, marked ${synthResult.observationsMarked} as reflected`
                      : '')
                );
              }
            } catch (err) {
              ctx.log(`[reflection] Synthesis failed: ${err}`);
            }
          }

          session.lastLinkCount = (session.lastLinkCount ?? 0) + cleanupResult.orphansConnected;
        } catch (err) {
          ctx.log(`[reflection] Graph cleanup failed: ${err}`);
        }
      } else {
        ctx.log(`[reflection] Skipping graph cleanup (no changes)`);
      }
    }

    if (idleConfig.operations?.write_reflection !== false) {
      ctx.log(`[reflection] Writing reflection for ${sessionId}`);
      try {
        const progressPath = ctx.getProgressFilePath(sessionId);
        const briefingContent = fs.existsSync(progressPath)
          ? fs.readFileSync(progressPath, 'utf-8')
          : briefingResult.briefing || '';

        if (briefingContent.length >= 100) {
          await writeReflection(briefingContent, idleConfig, ctx.log);
          ctx.log(`[reflection] Reflection written`);
        }
      } catch (err) {
        ctx.log(`[reflection] Write reflection error: ${err}`);
      }
    }

    ctx.log(`[reflection] Completed reflection for session ${sessionId}`);
  } catch (err) {
    ctx.log(`[reflection] Error for session ${sessionId}: ${err}`);
  }
}

export function reflectionRoutes(ctx: RouteContext): RouteMap {
  return {
    'POST /api/reflect': async (body) => {
      const { session_id } = parseRequestBody(ReflectBodySchema, body);
      const watcherConfig = getIdleWatcherConfig();
      const manager = requireSessionManager(ctx);

      if (session_id) {
        const session = manager.get(session_id);
        if (!session) {
          throw new NotFoundError('Session not found');
        }
        await performReflection(ctx, session_id, session);
        manager.markReflection(session_id);
        return { success: true, session_id };
      }

      const idleSessions = manager.getIdleSessions(watcherConfig.idle_minutes);
      for (const { sessionId, session } of idleSessions) {
        await performReflection(ctx, sessionId, session);
        manager.markReflection(sessionId);
      }
      return { success: true, sessions_processed: idleSessions.length };
    },

    'POST /api/briefing': async (body) => {
      const {
        transcript,
        transcript_path,
        session_id,
        format,
        include_learnings,
        include_memories,
        max_memories,
        use_cache,
      } = parseRequestBody(BriefingBodySchema, body);

      if (session_id && use_cache !== false) {
        const cached = briefingCache.get(session_id);
        if (cached) {
          const age = Date.now() - cached.generatedAt;
          if (age < BRIEFING_CACHE_MAX_AGE_MS) {
            ctx.log(
              `[briefing] Serving cached briefing for ${session_id.slice(0, 8)} (age: ${Math.round(age / 1000)}s)`
            );
            return { success: true, briefing: cached.briefing, cached: true };
          }
        }
      }

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

      if (session_id && result.success && result.briefing && transcript_path) {
        const stats = fs.existsSync(transcript_path) ? fs.statSync(transcript_path) : null;
        briefingCache.set(session_id, {
          briefing: result.briefing,
          generatedAt: Date.now(),
          transcriptSize: stats?.size || 0,
        });
      }

      return { ...result, cached: false };
    },
  };
}

export function initReflectionMaintenance(): void {
  cleanupStaleObservations();
}

export function disposeReflectionMaintenance(sessionId?: string): void {
  if (sessionId) {
    removeObservations(sessionId);
    clearBriefingCache(sessionId);
  }
}

/**
 * Session Processor - Progress-based session finalization
 *
 * Processes session data at session end:
 * 1. Reads progress file (accumulated idle reflection briefings) OR tail of transcript
 * 2. Extracts facts using LLM
 * 3. Saves facts as memories (with quality/duplicate checks)
 * 4. Generates next-session-context.md for handoff
 * 5. Cleans up progress file
 *
 * This is the NEW architecture (Variant B):
 * - Idle reflection → appends briefing to progress file
 * - Session end → reads progress file, extracts facts, generates context
 * - No more parsing 70MB transcripts at session end!
 */

import * as fs from 'fs';
import * as path from 'path';
import { saveMemory, searchMemories } from '../lib/db.js';
import { getEmbedding } from '../lib/embeddings.js';
import { getSuccDir, getIdleReflectionConfig, getConfig } from '../lib/config.js';
import { countTokens } from '../lib/token-counter.js';
import { scoreMemory, passesQualityThreshold } from '../lib/quality.js';
import { scanSensitive } from '../lib/sensitive-filter.js';
import { callLLM } from '../lib/llm.js';
import { SESSION_PROGRESS_EXTRACTION_PROMPT } from '../prompts/index.js';

// ============================================================================
// Types
// ============================================================================

interface TranscriptEntry {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system' | string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string; name?: string; input?: any }>;
  };
  tool_name?: string;
  tool_input?: any;
  tool_result?: any;
  timestamp?: string;
}

export interface ProcessingResult {
  summary: string;
  learnings: string[];
  saved: boolean;
  factsSaved?: number;
  factsSkipped?: number;
}

/**
 * Extracted fact from session content
 */
export interface ExtractedFact {
  content: string;
  type: 'decision' | 'learning' | 'observation' | 'error' | 'pattern';
  confidence: number;
  tags: string[];
}

// ============================================================================
// Progress File Management
// ============================================================================

/**
 * Get path to session progress file
 * @internal Exported for testing
 */
export function getProgressFilePath(sessionId: string): string {
  const succDir = getSuccDir();
  if (!succDir) return '';
  const tmpDir = path.join(succDir, '.tmp');
  return path.join(tmpDir, `session-${sessionId}-progress.md`);
}

/**
 * Read tail of transcript file (fallback when no progress file)
 * Returns the last maxBytes of the file, starting from a complete line
 * @internal Exported for testing
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
// Transcript Parsing
// ============================================================================

/**
 * Parse JSONL transcript file into entries
 */
export function parseTranscript(transcriptPath: string): TranscriptEntry[] {
  if (!fs.existsSync(transcriptPath)) {
    return [];
  }

  const content = fs.readFileSync(transcriptPath, 'utf8');
  const lines = content.split('\n').filter(line => line.trim());
  const entries: TranscriptEntry[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      entries.push(entry);
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

/**
 * Format transcript entries for summarization
 */
function formatEntries(entries: TranscriptEntry[]): string {
  const parts: string[] = [];

  for (const entry of entries) {
    if (entry.type === 'user' && entry.message?.content) {
      const content = typeof entry.message.content === 'string'
        ? entry.message.content
        : entry.message.content.map(c => c.text || '').join('\n');
      if (content.trim()) {
        parts.push(`USER: ${content.slice(0, 500)}`);
      }
    } else if (entry.type === 'assistant' && entry.message?.content) {
      const content = typeof entry.message.content === 'string'
        ? entry.message.content
        : entry.message.content.map(c => c.text || '').join('\n');
      if (content.trim()) {
        parts.push(`ASSISTANT: ${content.slice(0, 1000)}`);
      }
    } else if (entry.tool_name) {
      const input = JSON.stringify(entry.tool_input || {}).slice(0, 200);
      parts.push(`TOOL[${entry.tool_name}]: ${input}`);
    }
  }

  return parts.join('\n\n');
}

// ============================================================================
// Chunking
// ============================================================================

/**
 * Split entries into chunks of approximately targetTokens each
 */
function chunkEntries(entries: TranscriptEntry[], targetTokens: number = 25000): TranscriptEntry[][] {
  if (entries.length === 0) return [];

  const chunks: TranscriptEntry[][] = [];
  let currentChunk: TranscriptEntry[] = [];
  let currentTokens = 0;

  for (const entry of entries) {
    const formatted = formatEntries([entry]);
    const tokens = countTokens(formatted);

    if (currentTokens + tokens > targetTokens && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(entry);
    currentTokens += tokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

// ============================================================================
// LLM Integration (uses shared llm.ts module)
// ============================================================================

/**
 * Run LLM with a prompt and return the response
 * Uses sleep agent for background processing if enabled.
 */
async function runLLM(prompt: string, timeoutMs: number = 60000): Promise<string> {
  return callLLM(prompt, { timeout: timeoutMs, maxTokens: 2000, useSleepAgent: true });
}

// ============================================================================
// Summarization
// ============================================================================

/**
 * Summarize a single chunk of transcript
 */
async function summarizeChunk(entries: TranscriptEntry[], chunkIndex: number, totalChunks: number): Promise<string> {
  const formatted = formatEntries(entries);

  if (!formatted.trim()) {
    return '';
  }

  const prompt = `Summarize this part ${chunkIndex + 1}/${totalChunks} of a coding session transcript.

Focus on:
- What was accomplished (decisions made, code written/modified)
- Problems encountered and how they were solved
- Key technical details worth remembering

Be concise but include specific details (file names, function names, error messages).

Transcript:
---
${formatted}
---

Output a bullet-point summary (5-15 bullets).`;

  try {
    return await runLLM(prompt, 45000);
  } catch (err) {
    console.error(`[session-processor] Failed to summarize chunk ${chunkIndex + 1}: ${err}`);
    return '';
  }
}

/**
 * Combine multiple chunk summaries into a final handoff document
 */
async function combineSummaries(summaries: string[]): Promise<string> {
  const validSummaries = summaries.filter(s => s.trim());

  if (validSummaries.length === 0) {
    return '';
  }

  if (validSummaries.length === 1) {
    return validSummaries[0];
  }

  const prompt = `Combine these ${validSummaries.length} session summary parts into one cohesive handoff document.

Structure the output as:

## Accomplishments
- What was completed

## Current State
- What's working
- What's partially done

## Key Decisions
- Important choices made and why

## Next Steps
- What should be done next

Keep it concise (300-500 words total).

Summary Parts:
${validSummaries.map((s, i) => `### Part ${i + 1}\n${s}`).join('\n\n')}`;

  try {
    return await runLLM(prompt, 60000);
  } catch (err) {
    console.error(`[session-processor] Failed to combine summaries: ${err}`);
    // Fallback: just concatenate
    return validSummaries.join('\n\n---\n\n');
  }
}

/**
 * Extract reusable learnings from the summary
 */
async function extractLearnings(summary: string): Promise<string[]> {
  if (!summary.trim()) {
    return [];
  }

  const prompt = `Extract reusable learnings from this session summary.

Focus on:
- Bug fixes: what was wrong and how it was fixed
- Technical discoveries: APIs, patterns, gotchas
- Workarounds found for specific problems
- Configuration or setup knowledge

Each learning should be a standalone, reusable piece of knowledge.
Format as a bullet list with "-" prefix.
If there are no notable learnings, output exactly: NONE

Summary:
---
${summary}
---`;

  try {
    const result = await runLLM(prompt, 30000);

    if (result.toUpperCase().includes('NONE')) {
      return [];
    }

    // Parse bullet points
    const learnings = result
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('-') || line.startsWith('•'))
      .map(line => line.replace(/^[-•]\s*/, '').trim())
      .filter(line => line.length > 10);

    return learnings;
  } catch (err) {
    console.error(`[session-processor] Failed to extract learnings: ${err}`);
    return [];
  }
}

// ============================================================================
// Fact Extraction (from session-summary.ts logic)
// ============================================================================

/**
 * Extract facts from content using LLM
 * Uses the shared LLM module for backend flexibility.
 */
async function extractFactsFromContent(
  content: string,
  _model: string = 'haiku', // Ignored - uses global LLM config
  log: (msg: string) => void = console.log
): Promise<ExtractedFact[]> {
  const prompt = SESSION_PROGRESS_EXTRACTION_PROMPT.replace('{content}', content.slice(0, 15000)); // Limit content size

  try {
    const result = await runLLM(prompt, 45000);
    return parseFactsResponse(result);
  } catch (err) {
    log(`[session-processor] LLM extraction failed: ${err}`);
    return [];
  }
}

/**
 * Parse LLM response to ExtractedFact array
 * @internal Exported for testing
 */
export function parseFactsResponse(response: string): ExtractedFact[] {
  // Extract JSON array from response
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  // Validate and normalize facts
  return parsed
    .filter((f: any) =>
      f.content &&
      typeof f.content === 'string' &&
      f.content.length >= 50 &&
      ['decision', 'learning', 'observation', 'error', 'pattern'].includes(f.type)
    )
    .map((f: any) => ({
      content: f.content.trim(),
      type: f.type,
      confidence: Math.max(0, Math.min(1, f.confidence || 0.7)),
      tags: Array.isArray(f.tags) ? f.tags.filter((t: any) => typeof t === 'string') : [],
    }));
}

/**
 * Save extracted facts as memories with quality/duplicate checks
 */
async function saveFactsAsMemories(
  facts: ExtractedFact[],
  minQuality: number,
  log: (msg: string) => void = console.log
): Promise<{ saved: number; skipped: number }> {
  let saved = 0;
  let skipped = 0;
  const config = getConfig();

  for (const fact of facts) {
    try {
      // Check for sensitive info and redact if configured
      let content = fact.content;
      if (config.sensitive_filter_enabled !== false) {
        const scanResult = scanSensitive(content);
        if (scanResult.hasSensitive) {
          if (config.sensitive_auto_redact) {
            content = scanResult.redactedText;
          } else {
            skipped++;
            continue;
          }
        }
      }

      // Get embedding
      const embedding = await getEmbedding(content);

      // Check for duplicates
      const existing = searchMemories(embedding, 1, 0.9);
      if (existing.length > 0) {
        skipped++;
        continue;
      }

      // Score quality
      const qualityScore = await scoreMemory(content);
      if (qualityScore.score < minQuality) {
        skipped++;
        continue;
      }

      // Add session-summary tag
      const tags = [...fact.tags, 'session-summary', fact.type];

      // Save memory
      const result = saveMemory(content, embedding, tags, fact.type, {
        qualityScore: { score: qualityScore.score, factors: qualityScore.factors },
      });

      if (result.isDuplicate) {
        skipped++;
      } else {
        saved++;
      }
    } catch (err) {
      log(`[session-processor] Failed to save fact: ${err}`);
      skipped++;
    }
  }

  return { saved, skipped };
}

// ============================================================================
// Main Processing
// ============================================================================

/**
 * Process a session at session end (NEW: Progress-based architecture)
 *
 * 1. Read progress file (accumulated briefings) OR fallback to tail transcript
 * 2. Extract facts using LLM
 * 3. Save facts as memories
 * 4. Generate next-session-context.md
 * 5. Cleanup progress file
 */
export async function processSessionEnd(
  transcriptPath: string,
  sessionId: string,
  log: (msg: string) => void = console.log
): Promise<ProcessingResult> {
  log(`[session-processor] Processing session ${sessionId}`);

  const result: ProcessingResult = {
    summary: '',
    learnings: [],
    saved: false,
    factsSaved: 0,
    factsSkipped: 0,
  };

  try {
    const idleConfig = getIdleReflectionConfig();

    // 1. Try to read progress file first
    const progressPath = getProgressFilePath(sessionId);
    let content: string;
    let usingProgressFile = false;

    if (progressPath && fs.existsSync(progressPath)) {
      content = fs.readFileSync(progressPath, 'utf8');
      usingProgressFile = true;
      log(`[session-processor] Using progress file (${content.length} chars)`);
    } else {
      // Fallback: read tail of transcript (max 2MB)
      content = readTailTranscript(transcriptPath, 2 * 1024 * 1024);
      log(`[session-processor] Fallback to transcript tail (${content.length} chars)`);

      // If using transcript, need to parse and format it
      if (content) {
        content = formatTranscriptForExtraction(content);
      }
    }

    if (!content || content.length < 200) {
      log(`[session-processor] Content too short, skipping extraction`);
      // Still try to generate context from what we have
      if (content && content.length > 50) {
        await generateNextSessionContext(content, []);
        log(`[session-processor] Generated minimal next-session-context.md`);
      }
      return result;
    }

    // 2. Extract facts using LLM
    const model = idleConfig.agent_model || 'haiku';
    log(`[session-processor] Extracting facts (model: ${model})`);

    const facts = await extractFactsFromContent(content, model, log);
    log(`[session-processor] Extracted ${facts.length} facts`);

    if (facts.length === 0) {
      // No facts, but still generate context
      await generateNextSessionContext(content, []);
      log(`[session-processor] No facts, generated context from content`);
      return result;
    }

    // 3. Save facts as memories
    const minQuality = idleConfig.thresholds?.min_quality_for_summary ?? 0.5;
    const saveResult = await saveFactsAsMemories(facts, minQuality, log);

    result.factsSaved = saveResult.saved;
    result.factsSkipped = saveResult.skipped;
    result.saved = saveResult.saved > 0;

    log(`[session-processor] Saved ${saveResult.saved} facts, skipped ${saveResult.skipped}`);

    // Build learnings list from saved facts
    result.learnings = facts
      .filter(f => f.type === 'learning' || f.type === 'decision')
      .map(f => f.content);

    // Build summary from all facts
    result.summary = facts.map(f => `[${f.type}] ${f.content}`).join('\n\n');

    // 4. Generate next-session-context.md
    await generateNextSessionContext(content, result.learnings);
    log(`[session-processor] Generated next-session-context.md`);

    // 5. Cleanup progress file
    if (usingProgressFile && progressPath && fs.existsSync(progressPath)) {
      try {
        fs.unlinkSync(progressPath);
        log(`[session-processor] Cleaned up progress file`);
      } catch (err) {
        log(`[session-processor] Failed to cleanup progress file: ${err}`);
      }
    }

  } catch (err) {
    log(`[session-processor] Error processing session: ${err}`);
  }

  return result;
}

/**
 * Format raw JSONL transcript content for extraction
 * Used when falling back to transcript (no progress file)
 * @internal Exported for testing
 */
export function formatTranscriptForExtraction(transcriptContent: string): string {
  const lines = transcriptContent.trim().split('\n');

  const formatted = lines
    .map((line) => {
      try {
        const entry = JSON.parse(line);
        const getTextContent = (content: any): string => {
          if (typeof content === 'string') return content;
          if (Array.isArray(content)) {
            return content
              .filter((block: any) => block.type === 'text' && block.text)
              .map((block: any) => block.text)
              .join(' ');
          }
          return '';
        };

        if (entry.type === 'assistant' && entry.message?.content) {
          const text = getTextContent(entry.message.content);
          if (text) return `Assistant: ${text.substring(0, 1000)}`;
        }
        if ((entry.type === 'human' || entry.type === 'user') && entry.message?.content) {
          const text = getTextContent(entry.message.content);
          if (text) return `User: ${text.substring(0, 500)}`;
        }
      } catch {
        return null;
      }
      return null;
    })
    .filter(Boolean)
    .join('\n\n');

  return formatted;
}

/**
 * Generate next-session-context.md for session handoff
 * APPENDS to existing file to support multiple sessions
 * Uses progress file content (already formatted briefings) or summary
 */
async function generateNextSessionContext(content: string, learnings: string[]): Promise<void> {
  const succDir = getSuccDir();
  if (!succDir) return;

  const contextPath = path.join(succDir, 'next-session-context.md');
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0].substring(0, 5);

  // Build session section
  let sessionSection: string;

  if (content.includes('## ') && content.includes('Idle Reflection')) {
    // Progress file content - already formatted
    sessionSection = `## Session ${dateStr} ${timeStr}\n\n`;
    sessionSection += content;
  } else {
    // Summary or transcript content - need to structure it
    sessionSection = `## Session ${dateStr} ${timeStr}\n\n`;
    sessionSection += content.slice(0, 5000); // Limit size
  }

  if (learnings.length > 0) {
    sessionSection += '\n\n### Key Learnings\n\n';
    sessionSection += learnings.map(l => `- ${l}`).join('\n');
  }

  sessionSection += '\n\n---\n\n';

  try {
    // Check if file exists and needs header
    const needsHeader = !fs.existsSync(contextPath);

    if (needsHeader) {
      const header = `# Session Handoffs\n\n*Multiple sessions accumulated. Will be compacted on daemon shutdown.*\n\n---\n\n`;
      fs.writeFileSync(contextPath, header + sessionSection);
    } else {
      // Append to existing file
      fs.appendFileSync(contextPath, sessionSection);
    }
  } catch {
    // Failed to write, ignore
  }
}

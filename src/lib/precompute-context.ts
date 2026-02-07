/**
 * Precompute Context Module
 *
 * Prepares context for the next session during idle time.
 * Analyzes current session, selects relevant memories,
 * and generates a briefing document.
 *
 * Part of idle-time compute (sleep-time compute) operations.
 */

import { searchMemories, closeDb, getRecentMemories } from './storage/index.js';
import { getEmbedding } from './embeddings.js';
import { getProjectRoot } from './config.js';
import { callLLM, type LLMBackend } from './llm.js';
import { SESSION_BRIEFING_PROMPT } from '../prompts/index.js';
import fs from 'fs';
import path from 'path';

/**
 * Context prepared for next session
 */
export interface PrecomputedContext {
  sessionSummary: string;
  relevantMemories: Array<{
    content: string;
    tags: string[];
    relevance: number;
  }>;
  suggestedFocus: string[];
  generatedAt: string;
}

/**
 * Result of precompute operation
 */
export interface PrecomputeResult {
  success: boolean;
  contextFile?: string;
  memoriesIncluded: number;
  error?: string;
}

/**
 * Extract key topics from transcript for memory search
 */
function extractTopicsFromTranscript(transcript: string): string[] {
  const topics: string[] = [];

  // Extract file paths mentioned
  const fileMatches = transcript.match(/(?:src|lib|components|pages|api|hooks|utils|test)\/[\w\-./]+\.\w+/gi);
  if (fileMatches) {
    topics.push(...fileMatches.slice(0, 5));
  }

  // Extract function/class names (CamelCase or snake_case)
  const identifierMatches = transcript.match(/\b([A-Z][a-z]+[A-Z][a-zA-Z]*|[a-z]+_[a-z_]+)\b/g);
  if (identifierMatches) {
    const unique = [...new Set(identifierMatches)];
    topics.push(...unique.slice(0, 5));
  }

  // Extract key phrases
  const keyPhrases = [
    'implement', 'fix', 'add', 'update', 'refactor', 'bug', 'error', 'feature',
    'реализовать', 'исправить', 'добавить', 'обновить', 'рефакторинг', 'баг', 'ошибка', 'фича'
  ];

  for (const phrase of keyPhrases) {
    const regex = new RegExp(`${phrase}\\s+[\\w\\-]+`, 'gi');
    const matches = transcript.match(regex);
    if (matches) {
      topics.push(...matches.slice(0, 2));
    }
  }

  return [...new Set(topics)].slice(0, 10);
}

/**
 * Find relevant memories for the session context
 */
async function findRelevantMemories(
  transcript: string,
  limit: number = 5
): Promise<Array<{ content: string; tags: string[]; relevance: number }>> {
  const topics = extractTopicsFromTranscript(transcript);

  if (topics.length === 0) {
    // Fall back to recent memories if no topics extracted
    const recent = await getRecentMemories(limit);
    return recent.map(m => ({
      content: m.content,
      tags: m.tags,
      relevance: 0.5,
    }));
  }

  // Search for memories related to extracted topics
  const searchQuery = topics.join(' ');
  const embedding = await getEmbedding(searchQuery);
  const results = await searchMemories(embedding, limit, 0.3);

  return results.map(m => ({
    content: m.content,
    tags: m.tags,
    relevance: m.similarity,
  }));
}

/**
 * Generate briefing using LLM
 * Uses the unified llm.* config from config.json
 */
async function generateBriefingWithLLM(
  transcript: string,
  memories: Array<{ content: string; tags: string[]; relevance: number }>,
  backendOverride?: LLMBackend
): Promise<string | null> {
  const memoriesText = memories
    .map(m => `[${m.tags.join(', ')}] ${m.content}`)
    .join('\n\n');

  const prompt = SESSION_BRIEFING_PROMPT
    .replace('{transcript}', transcript.substring(0, 4000))
    .replace('{memories}', memoriesText || 'No relevant memories found.');

  try {
    // Use sleep agent for background precomputation if enabled
    const configOverride = backendOverride ? { backend: backendOverride } : undefined;
    const result = await callLLM(prompt, { timeout: 45000, maxTokens: 1000, useSleepAgent: true }, configOverride);
    return result?.trim() || null;
  } catch (error) {
    console.warn(`[precompute-context] LLM briefing failed:`, error);
    return null;
  }
}

/**
 * Main function: precompute context for next session
 */
export async function precomputeContext(
  transcript: string,
  options: {
    verbose?: boolean;
    dryRun?: boolean;
    // CLI overrides for LLM backend selection
    local?: boolean;
    openrouter?: boolean;
  } = {}
): Promise<PrecomputeResult> {
  const { verbose = false, dryRun = false } = options;

  const result: PrecomputeResult = {
    success: false,
    memoriesIncluded: 0,
  };

  try {
    // Find relevant memories
    if (verbose) {
      console.log('Finding relevant memories...');
    }

    const memories = await findRelevantMemories(transcript, 5);
    result.memoriesIncluded = memories.length;

    if (verbose) {
      console.log(`Found ${memories.length} relevant memories`);
    }

    // Determine backend override from CLI flags (if any)
    // Otherwise uses unified llm.* config
    let backendOverride: LLMBackend | undefined;
    if (options.local) {
      backendOverride = 'local';
    } else if (options.openrouter) {
      backendOverride = 'openrouter';
    }

    if (verbose) {
      console.log(`Using ${backendOverride || 'configured'} backend for briefing generation`);
    }

    // Generate briefing
    if (verbose) {
      console.log('Generating session briefing...');
    }

    const briefing = await generateBriefingWithLLM(transcript, memories, backendOverride);

    if (!briefing) {
      result.error = 'Failed to generate briefing';
      closeDb();
      return result;
    }

    if (verbose) {
      console.log('Briefing generated successfully');
    }

    // Save to file
    const projectRoot = getProjectRoot();
    const contextFile = path.join(projectRoot, '.succ', 'next-session-context.md');
    const succDir = path.dirname(contextFile);

    if (!fs.existsSync(succDir)) {
      fs.mkdirSync(succDir, { recursive: true });
    }

    const now = new Date();
    const timestamp = now.toISOString();

    // Build memories section only if there are memories
    const memoriesSection = memories.length > 0
      ? `\n---\n\n## Relevant Memories\n\n${memories.map(m => `- [${m.tags.join(', ')}] ${m.content.substring(0, 200)}${m.content.length > 200 ? '...' : ''}`).join('\n')}`
      : '';

    const contextContent = `# Next Session Context

*Generated: ${timestamp}*

${briefing}
${memoriesSection}
---

*This file is auto-generated by succ idle reflection. It will be loaded in the next session-start.*
`;

    if (dryRun) {
      if (verbose) {
        console.log('\nDry run - would write to:', contextFile);
        console.log('\n--- Content ---');
        console.log(contextContent);
        console.log('--- End ---');
      }
    } else {
      fs.writeFileSync(contextFile, contextContent);
      result.contextFile = contextFile;
    }

    result.success = true;

  } catch (error) {
    result.error = String(error);
  }

  closeDb();
  return result;
}

/**
 * CLI command for precompute context
 */
export async function precomputeContextCLI(
  transcriptPath: string,
  options: {
    dryRun?: boolean;
    verbose?: boolean;
    local?: boolean;
    openrouter?: boolean;
  } = {}
): Promise<void> {
  if (!fs.existsSync(transcriptPath)) {
    console.error(`Transcript file not found: ${transcriptPath}`);
    process.exit(1);
  }

  const transcriptContent = fs.readFileSync(transcriptPath, 'utf-8');

  // Parse JSONL transcript
  const lines = transcriptContent.trim().split('\n');
  const transcript = lines
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

  if (transcript.length < 200) {
    console.log('Transcript too short for context precomputation.');
    return;
  }

  console.log('Precomputing context for next session...\n');

  const result = await precomputeContext(transcript, {
    dryRun: options.dryRun,
    verbose: options.verbose ?? true,
    local: options.local,
    openrouter: options.openrouter,
  });

  console.log('\nPrecompute Results:');
  console.log(`  Success: ${result.success}`);
  console.log(`  Memories included: ${result.memoriesIncluded}`);

  if (result.contextFile) {
    console.log(`  Output file: ${result.contextFile}`);
  }

  if (result.error) {
    console.log(`  Error: ${result.error}`);
  }
}

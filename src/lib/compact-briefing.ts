/**
 * Compact Briefing Module
 *
 * Generates context briefing after /compact command.
 * Summarizes what was accomplished in the session and provides
 * context for continuation.
 */

import { getCompactBriefingConfig, CompactBriefingConfig } from './config.js';
import { searchMemories, getRecentMemories } from './storage/index.js';
import { getEmbedding } from './embeddings.js';
import { callLLM } from './llm.js';
import {
  BRIEFING_STRUCTURED_PROMPT,
  BRIEFING_PROSE_PROMPT,
  BRIEFING_MINIMAL_PROMPT,
} from '../prompts/index.js';

// ============================================================================
// Types
// ============================================================================

export interface BriefingResult {
  success: boolean;
  briefing?: string;
  error?: string;
}

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

// ============================================================================
// Transcript Parsing
// ============================================================================

/**
 * Parse JSONL transcript content into formatted text
 */
function parseTranscript(content: string): string {
  const lines = content.split('\n').filter(line => line.trim());
  const parts: string[] = [];

  for (const line of lines) {
    try {
      const entry: TranscriptEntry = JSON.parse(line);

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

      if (entry.type === 'user' && entry.message?.content) {
        const text = getTextContent(entry.message.content);
        if (text.trim()) {
          parts.push(`USER: ${text.slice(0, 500)}`);
        }
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const text = getTextContent(entry.message.content);
        if (text.trim()) {
          parts.push(`ASSISTANT: ${text.slice(0, 1000)}`);
        }
      } else if (entry.tool_name) {
        const input = JSON.stringify(entry.tool_input || {}).slice(0, 200);
        parts.push(`TOOL[${entry.tool_name}]: ${input}`);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return parts.join('\n\n');
}

// ============================================================================
// Memory Integration
// ============================================================================

/**
 * Find relevant memories for the session
 */
async function findRelevantMemories(
  transcript: string,
  limit: number
): Promise<Array<{ content: string; tags: string[] }>> {
  try {
    // Extract key topics from transcript for search
    const topics = extractTopics(transcript);

    if (topics.length === 0) {
      // Fall back to recent memories
      const recent = await getRecentMemories(limit);
      return recent.map(m => ({ content: m.content, tags: m.tags }));
    }

    const searchQuery = topics.join(' ');
    const embedding = await getEmbedding(searchQuery);
    const results = await searchMemories(embedding, limit, 0.3);

    return results.map(m => ({ content: m.content, tags: m.tags }));
  } catch {
    return [];
  }
}

/**
 * Extract key topics from transcript for memory search
 */
function extractTopics(transcript: string): string[] {
  const topics: string[] = [];

  // Extract file paths
  const fileMatches = transcript.match(/(?:src|lib|components|pages|api|hooks|utils|test)\/[\w\-./]+\.\w+/gi);
  if (fileMatches) {
    topics.push(...fileMatches.slice(0, 3));
  }

  // Extract function/class names
  const identifierMatches = transcript.match(/\b([A-Z][a-z]+[A-Z][a-zA-Z]*|[a-z]+_[a-z_]+)\b/g);
  if (identifierMatches) {
    const unique = [...new Set(identifierMatches)];
    topics.push(...unique.slice(0, 3));
  }

  return [...new Set(topics)].slice(0, 5);
}

// ============================================================================
// LLM Integration (uses shared llm.ts module)
// ============================================================================

/**
 * Generate briefing using unified llm.* config
 */
async function generateBriefingText(
  prompt: string,
  config: CompactBriefingConfig
): Promise<string> {
  const timeoutMs = config.timeout_ms || 30000;

  // Use unified llm.* config only
  return callLLM(prompt, { timeout: timeoutMs, maxTokens: 2000 });
}

// ============================================================================
// Main Briefing Generation
// ============================================================================

/**
 * Generate compact briefing from transcript
 */
export async function generateCompactBriefing(
  transcriptContent: string,
  options?: Partial<CompactBriefingConfig>
): Promise<BriefingResult> {
  const config = getCompactBriefingConfig();
  const mergedConfig = { ...config, ...options };

  if (!mergedConfig.enabled) {
    return { success: false, error: 'Compact briefing is disabled' };
  }

  try {
    // Parse transcript
    const transcript = parseTranscript(transcriptContent);

    if (transcript.length < 200) {
      return { success: false, error: 'Transcript too short for briefing' };
    }

    // Limit transcript to avoid token limits (use last ~4000 chars for recency)
    const truncatedTranscript = transcript.length > 6000
      ? transcript.slice(-6000)
      : transcript;

    // Get relevant memories if enabled
    let memoriesSection = '';
    if (mergedConfig.include_memories) {
      const memories = await findRelevantMemories(transcript, mergedConfig.max_memories);
      if (memories.length > 0) {
        memoriesSection = `Relevant context from previous sessions:\n${memories.map(m => `- [${m.tags.join(', ')}] ${m.content.slice(0, 200)}`).join('\n')}`;
      }
    }

    // Select prompt based on format
    let promptTemplate: string;
    switch (mergedConfig.format) {
      case 'prose':
        promptTemplate = BRIEFING_PROSE_PROMPT;
        break;
      case 'minimal':
        promptTemplate = BRIEFING_MINIMAL_PROMPT;
        break;
      case 'structured':
      default:
        promptTemplate = BRIEFING_STRUCTURED_PROMPT;
        break;
    }

    // Build final prompt
    const prompt = promptTemplate
      .replace('{transcript}', truncatedTranscript)
      .replace('{memories_section}', memoriesSection || '');

    // Generate briefing using configured provider
    const briefing = await generateBriefingText(prompt, mergedConfig);

    if (!briefing.trim()) {
      return { success: false, error: 'Empty briefing generated' };
    }

    return { success: true, briefing };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * Generate briefing from transcript file path
 */
export async function generateBriefingFromFile(
  transcriptPath: string,
  options?: Partial<CompactBriefingConfig>
): Promise<BriefingResult> {
  const fs = await import('fs');

  if (!fs.existsSync(transcriptPath)) {
    return { success: false, error: `Transcript file not found: ${transcriptPath}` };
  }

  const content = fs.readFileSync(transcriptPath, 'utf-8');
  return generateCompactBriefing(content, options);
}

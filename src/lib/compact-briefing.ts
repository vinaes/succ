/**
 * Compact Briefing Module
 *
 * Generates context briefing after /compact command.
 * Summarizes what was accomplished in the session and provides
 * context for continuation.
 */

import spawn from 'cross-spawn';
import { getCompactBriefingConfig, getConfig, CompactBriefingConfig } from './config.js';
import { searchMemories, getRecentMemories } from './db.js';
import { getEmbedding } from './embeddings.js';

// Default model mappings
const DEFAULT_MODELS = {
  local: 'haiku',
  openrouter: 'anthropic/claude-3-haiku',
  custom: 'llama3.2',  // Common default for Ollama
} as const;

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
// Prompts for Different Formats
// ============================================================================

const STRUCTURED_PROMPT = `Summarize this coding session for handoff to a fresh context.

Session transcript:
---
{transcript}
---

{memories_section}

Output in this EXACT XML format (keep the XML tags exactly as shown):

<task>
[1-2 sentences: what was the main goal/task being worked on]
</task>

<completed>
- [bullet point: what was done]
- [bullet point: what was done]
</completed>

<in-progress>
- [bullet point: what's partially done or being tested]
</in-progress>

<decisions>
- [bullet point: key technical decision made and why]
</decisions>

<next-steps priority="high">
- [bullet point: what to do next]
- [bullet point: what to do next]
</next-steps>

Be concise and specific. Include file names, function names, and technical details.
If a section is empty (e.g., no decisions), output the tag with "None" inside.`;

const PROSE_PROMPT = `Summarize this coding session for handoff to a fresh context.

Session transcript:
---
{transcript}
---

{memories_section}

Output in this EXACT XML format:

<task>[1 sentence: main goal]</task>

<summary>
[2-3 paragraphs covering: what was accomplished, current state, key decisions, what's next]
</summary>

<continue-with hint="start here">
[1 sentence: the immediate next action to take]
</continue-with>

Be conversational but concise. Include specific technical details (files, functions, errors).`;

const MINIMAL_PROMPT = `Summarize this coding session in exactly 4 lines.

Session transcript:
---
{transcript}
---

{memories_section}

Output EXACTLY 4 lines:
Task: [what was being done]
Done: [what was completed]
State: [current status]
Next: [what to do next]

Be extremely concise. Use technical terms.`;

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
      const recent = getRecentMemories(limit);
      return recent.map(m => ({ content: m.content, tags: m.tags }));
    }

    const searchQuery = topics.join(' ');
    const embedding = await getEmbedding(searchQuery);
    const results = searchMemories(embedding, limit, 0.3);

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
// LLM Providers
// ============================================================================

/**
 * Run Claude CLI with a prompt (local mode - spawns process, slow but works offline)
 */
async function runClaudeCLI(
  prompt: string,
  model: string = 'haiku',
  timeoutMs: number = 45000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--tools', '', '--model', model], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      windowsHide: true,
      env: { ...process.env, SUCC_SERVICE_SESSION: '1' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });

    // Write prompt and close stdin
    proc.stdin?.write(prompt);
    proc.stdin?.end();

    // Timeout
    setTimeout(() => {
      proc.kill();
      reject(new Error('Claude CLI timeout'));
    }, timeoutMs);
  });
}

/**
 * Generate briefing using OpenRouter API (fast, requires API key)
 */
async function generateWithOpenRouter(
  prompt: string,
  apiKey: string,
  model: string = 'anthropic/claude-3-haiku',
  timeoutMs: number = 15000
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() || '';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generate briefing using custom OpenAI-compatible API (Ollama, LM Studio, llama.cpp)
 */
async function generateWithCustomAPI(
  prompt: string,
  apiUrl: string,
  model: string,
  apiKey?: string,
  timeoutMs: number = 15000
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Ensure URL ends with /chat/completions
  let endpoint = apiUrl;
  if (!endpoint.endsWith('/chat/completions')) {
    endpoint = endpoint.replace(/\/$/, '') + '/chat/completions';
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Custom API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() || '';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generate briefing using configured provider
 */
async function generateBriefingText(
  prompt: string,
  config: CompactBriefingConfig
): Promise<string> {
  const globalConfig = getConfig();
  const mode = config.mode || 'local';
  const timeoutMs = config.timeout_ms || 15000;

  switch (mode) {
    case 'openrouter': {
      const apiKey = config.api_key || globalConfig.openrouter_api_key;
      if (!apiKey) {
        throw new Error('OpenRouter API key not configured. Set openrouter_api_key in config or compact_briefing.api_key');
      }
      const model = config.model || DEFAULT_MODELS.openrouter;
      return generateWithOpenRouter(prompt, apiKey, model, timeoutMs);
    }

    case 'custom': {
      const apiUrl = config.api_url || globalConfig.analyze_api_url;
      if (!apiUrl) {
        throw new Error('Custom API URL not configured. Set compact_briefing.api_url or analyze_api_url');
      }
      const model = config.model || globalConfig.analyze_model || DEFAULT_MODELS.custom;
      const apiKey = config.api_key || globalConfig.analyze_api_key;
      return generateWithCustomAPI(prompt, apiUrl, model, apiKey, timeoutMs);
    }

    case 'local':
    default: {
      // Local mode uses Claude CLI (slow but works without additional config)
      const model = config.model || DEFAULT_MODELS.local;
      return runClaudeCLI(prompt, model, timeoutMs);
    }
  }
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
        promptTemplate = PROSE_PROMPT;
        break;
      case 'minimal':
        promptTemplate = MINIMAL_PROMPT;
        break;
      case 'structured':
      default:
        promptTemplate = STRUCTURED_PROMPT;
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

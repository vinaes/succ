/**
 * Precompute Context Module
 *
 * Prepares context for the next session during idle time.
 * Analyzes current session, selects relevant memories,
 * and generates a briefing document.
 *
 * Part of idle-time compute (sleep-time compute) operations.
 */

import { searchMemories, closeDb, getRecentMemories } from './db.js';
import { getEmbedding } from './embeddings.js';
import { getIdleReflectionConfig, getConfig, getProjectRoot } from './config.js';
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
 * Prompt for generating session briefing
 */
const BRIEFING_PROMPT = `You are preparing a briefing for an AI assistant's next coding session.

Session transcript (recent activity):
---
{transcript}
---

Relevant memories from past sessions:
---
{memories}
---

Generate a concise briefing (3-5 bullet points) that will help the assistant quickly understand:
1. What was being worked on
2. Current state/progress
3. Any pending tasks or issues
4. Key context to remember

Output format:
## Session Briefing

- [bullet point 1]
- [bullet point 2]
...

## Suggested Focus
[One sentence about what to focus on next]`;

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
    const recent = getRecentMemories(limit);
    return recent.map(m => ({
      content: m.content,
      tags: m.tags,
      relevance: 0.5,
    }));
  }

  // Search for memories related to extracted topics
  const searchQuery = topics.join(' ');
  const embedding = await getEmbedding(searchQuery);
  const results = searchMemories(embedding, limit, 0.3);

  return results.map(m => ({
    content: m.content,
    tags: m.tags,
    relevance: m.similarity,
  }));
}

/**
 * Generate briefing using LLM
 */
async function generateBriefingWithLLM(
  transcript: string,
  memories: Array<{ content: string; tags: string[]; relevance: number }>,
  options: {
    mode: 'claude' | 'local' | 'openrouter';
    model?: string;
    apiUrl?: string;
    apiKey?: string;
  }
): Promise<string | null> {
  const memoriesText = memories
    .map(m => `[${m.tags.join(', ')}] ${m.content}`)
    .join('\n\n');

  const prompt = BRIEFING_PROMPT
    .replace('{transcript}', transcript.substring(0, 4000))
    .replace('{memories}', memoriesText || 'No relevant memories found.');

  if (options.mode === 'claude') {
    return generateWithClaudeCLI(prompt, options.model || 'haiku');
  } else if (options.mode === 'local') {
    return generateWithLocalAPI(prompt, options.apiUrl!, options.model!);
  } else if (options.mode === 'openrouter') {
    return generateWithOpenRouter(prompt, options.apiKey!, options.model!);
  }

  return null;
}

/**
 * Generate briefing using Claude CLI
 */
async function generateWithClaudeCLI(prompt: string, model: string): Promise<string | null> {
  const spawn = (await import('cross-spawn')).default;

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

    proc.on('close', (code: number) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => {
      resolve(null);
    });

    setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 45000);
  });
}

/**
 * Generate briefing using local LLM API
 */
async function generateWithLocalAPI(
  prompt: string,
  apiUrl: string,
  model: string
): Promise<string | null> {
  try {
    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'You prepare briefings for coding sessions. Be concise and actionable.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

/**
 * Generate briefing using OpenRouter API
 */
async function generateWithOpenRouter(
  prompt: string,
  apiKey: string,
  model: string
): Promise<string | null> {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/anthropics/succ',
        'X-Title': 'succ - Precompute Context',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'You prepare briefings for coding sessions. Be concise and actionable.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch {
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
    // CLI overrides for LLM selection
    local?: boolean;
    openrouter?: boolean;
    apiUrl?: string;
    model?: string;
  } = {}
): Promise<PrecomputeResult> {
  const { verbose = false, dryRun = false } = options;
  const config = getIdleReflectionConfig();
  const globalConfig = getConfig();

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

    // Determine which agent to use
    // CLI flags take priority over config
    let llmOptions: {
      mode: 'claude' | 'local' | 'openrouter';
      model?: string;
      apiUrl?: string;
      apiKey?: string;
    };

    if (options.local) {
      // CLI: --local flag
      llmOptions = {
        mode: 'local',
        model: options.model || config.sleep_agent?.model || 'qwen2.5-coder:14b',
        apiUrl: options.apiUrl || config.sleep_agent?.api_url || 'http://localhost:11434/v1',
      };
    } else if (options.openrouter) {
      // CLI: --openrouter flag
      llmOptions = {
        mode: 'openrouter',
        model: options.model || config.sleep_agent?.model || 'anthropic/claude-3-haiku',
        apiKey: config.sleep_agent?.api_key || globalConfig.openrouter_api_key,
      };
    } else {
      // Use config-based selection
      const sleepAgent = config.sleep_agent;
      const useSleepAgent = sleepAgent.enabled && sleepAgent.model && sleepAgent.handle_operations?.precompute_context;

      if (useSleepAgent) {
        llmOptions = {
          mode: sleepAgent.mode as 'local' | 'openrouter',
          model: sleepAgent.model,
          apiUrl: sleepAgent.api_url,
          apiKey: sleepAgent.api_key || globalConfig.openrouter_api_key,
        };
      } else {
        llmOptions = {
          mode: 'claude',
          model: config.agent_model,
        };
      }
    }

    if (verbose) {
      console.log(`Using ${llmOptions.mode} mode for briefing generation`);
    }

    // Generate briefing
    if (verbose) {
      console.log('Generating session briefing...');
    }

    const briefing = await generateBriefingWithLLM(transcript, memories, llmOptions);

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
    apiUrl?: string;
    model?: string;
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
    apiUrl: options.apiUrl,
    model: options.model,
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

/**
 * Session Summary Extraction Module
 *
 * Extracts key facts and learnings from session transcripts
 * and saves them as memories for future reference.
 *
 * Part of idle-time compute (sleep-time compute) operations.
 */

import { saveMemory, searchMemories, closeDb, recordTokenStat } from './db.js';
import { getEmbedding } from './embeddings.js';
import { getIdleReflectionConfig, getConfig } from './config.js';
import { scoreMemory, passesQualityThreshold } from './quality.js';
import { scanSensitive } from './sensitive-filter.js';
import { countTokens } from './token-counter.js';
import { estimateSavings, getCurrentModel } from './pricing.js';

/**
 * Extracted fact from session
 */
export interface ExtractedFact {
  content: string;
  type: 'decision' | 'learning' | 'observation' | 'error' | 'pattern';
  confidence: number;
  tags: string[];
}

/**
 * Result of session summary extraction
 */
export interface SessionSummaryResult {
  factsExtracted: number;
  factsSaved: number;
  factsSkipped: number;
  errors: string[];
  // Token stats for tracking savings
  transcriptTokens?: number;
  summaryTokens?: number;
}

/**
 * Prompt for extracting facts from session transcript
 */
const EXTRACTION_PROMPT = `You are analyzing a coding session transcript to extract key facts worth remembering.

Session transcript:
---
{transcript}
---

Extract concrete, actionable facts from this session. Focus on:
1. **Decisions** - choices made about architecture, tools, approaches
2. **Learnings** - new understanding gained, gotchas discovered
3. **Observations** - facts about the codebase, patterns noticed
4. **Errors** - bugs found and how they were fixed
5. **Patterns** - recurring themes or approaches used

Rules:
- Extract ONLY facts that would be useful in future sessions
- Be specific: include file names, function names, commands when mentioned
- Skip generic conversation, greetings, confirmations
- Each fact should stand alone (make sense without the full transcript)
- Minimum 50 characters per fact

Output as JSON array:
[
  {
    "content": "The authentication middleware in src/auth/middleware.ts uses JWT tokens with 1-hour expiry",
    "type": "observation",
    "confidence": 0.9,
    "tags": ["auth", "jwt", "middleware"]
  },
  ...
]

If no meaningful facts found, return: []`;

/**
 * Call LLM to extract facts from transcript
 */
async function extractFactsWithLLM(
  transcript: string,
  options: {
    mode: 'claude' | 'local' | 'openrouter';
    model?: string;
    apiUrl?: string;
    apiKey?: string;
  }
): Promise<ExtractedFact[]> {
  const prompt = EXTRACTION_PROMPT.replace('{transcript}', transcript);

  if (options.mode === 'claude') {
    // Use Claude CLI (spawn process)
    return extractWithClaudeCLI(prompt, options.model || 'haiku');
  } else if (options.mode === 'local') {
    // Use local LLM API (Ollama, LM Studio)
    return extractWithLocalAPI(prompt, options.apiUrl!, options.model!);
  } else if (options.mode === 'openrouter') {
    // Use OpenRouter API
    return extractWithOpenRouter(prompt, options.apiKey!, options.model!);
  }

  return [];
}

/**
 * Extract facts using Claude CLI
 */
async function extractWithClaudeCLI(prompt: string, model: string): Promise<ExtractedFact[]> {
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
        try {
          const facts = parseFactsResponse(stdout);
          resolve(facts);
        } catch {
          resolve([]);
        }
      } else {
        resolve([]);
      }
    });

    proc.on('error', () => {
      resolve([]);
    });

    // Timeout
    setTimeout(() => {
      proc.kill();
      resolve([]);
    }, 30000);
  });
}

/**
 * Extract facts using local LLM API (Ollama, LM Studio)
 */
async function extractWithLocalAPI(
  prompt: string,
  apiUrl: string,
  model: string
): Promise<ExtractedFact[]> {
  try {
    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'You extract facts from coding sessions. Respond only with valid JSON arrays.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    return parseFactsResponse(content);
  } catch (error) {
    console.warn('Local LLM extraction failed:', error);
    return [];
  }
}

/**
 * Extract facts using OpenRouter API
 */
async function extractWithOpenRouter(
  prompt: string,
  apiKey: string,
  model: string
): Promise<ExtractedFact[]> {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/anthropics/succ',
        'X-Title': 'succ - Session Summary',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'You extract facts from coding sessions. Respond only with valid JSON arrays.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    return parseFactsResponse(content);
  } catch (error) {
    console.warn('OpenRouter extraction failed:', error);
    return [];
  }
}

/**
 * Parse LLM response to ExtractedFact array
 */
function parseFactsResponse(response: string): ExtractedFact[] {
  try {
    // Extract JSON array from response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
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
  } catch {
    return [];
  }
}

/**
 * Save extracted facts as memories
 */
async function saveFactsAsMemories(
  facts: ExtractedFact[],
  minQuality: number,
  onProgress?: (current: number, total: number) => void
): Promise<{ saved: number; skipped: number; errors: string[] }> {
  let saved = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    onProgress?.(i + 1, facts.length);

    try {
      // Check for sensitive info and redact if configured
      const config = getConfig();
      let content = fact.content;
      if (config.sensitive_filter_enabled !== false) {
        const scanResult = scanSensitive(content);
        if (scanResult.hasSensitive) {
          if (config.sensitive_auto_redact) {
            content = scanResult.redactedText;
          } else {
            // Skip facts with sensitive info when auto-redact is off
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
      const result = saveMemory(content, embedding, tags, 'session-summary', {
        qualityScore: { score: qualityScore.score, factors: qualityScore.factors },
      });

      if (result.isDuplicate) {
        skipped++;
      } else {
        saved++;
      }
    } catch (error) {
      errors.push(`Failed to save fact: ${fact.content.substring(0, 50)}...`);
    }
  }

  return { saved, skipped, errors };
}

/**
 * Extract and save session summary
 * Main entry point for session summary operation
 */
export async function extractSessionSummary(
  transcript: string,
  options: {
    verbose?: boolean;
    dryRun?: boolean;
    onProgress?: (current: number, total: number, action: string) => void;
    // CLI overrides for LLM selection
    local?: boolean;
    openrouter?: boolean;
    apiUrl?: string;
    model?: string;
  } = {}
): Promise<SessionSummaryResult> {
  const { verbose = false, dryRun = false, onProgress } = options;
  const config = getIdleReflectionConfig();
  const globalConfig = getConfig();

  const result: SessionSummaryResult = {
    factsExtracted: 0,
    factsSaved: 0,
    factsSkipped: 0,
    errors: [],
    transcriptTokens: countTokens(transcript),
    summaryTokens: 0,
  };

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
    const useSleepAgent = sleepAgent.enabled && sleepAgent.model && sleepAgent.handle_operations?.session_summary;

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
    console.log(`Using ${llmOptions.mode} mode for extraction (model: ${llmOptions.model || 'default'})`);
  }

  // Extract facts from transcript
  onProgress?.(1, 3, 'extracting facts');

  if (verbose) {
    console.log('Extracting facts from transcript...');
  }

  const facts = await extractFactsWithLLM(transcript, llmOptions);
  result.factsExtracted = facts.length;

  // Calculate summary tokens (all fact contents combined)
  result.summaryTokens = facts.reduce((sum, f) => sum + countTokens(f.content), 0);

  if (verbose) {
    console.log(`Found ${facts.length} potential facts`);
  }

  if (facts.length === 0) {
    return result;
  }

  // Save facts as memories
  onProgress?.(2, 3, 'saving memories');

  if (dryRun) {
    if (verbose) {
      console.log('\nDry run - facts that would be saved:');
      for (const fact of facts) {
        console.log(`  [${fact.type}] ${fact.content.substring(0, 100)}...`);
        console.log(`    Tags: ${fact.tags.join(', ')} | Confidence: ${(fact.confidence * 100).toFixed(0)}%`);
      }
    }
    result.factsSaved = 0;
    result.factsSkipped = facts.length;
  } else {
    const minQuality = config.thresholds.min_quality_for_summary ?? 0.5;
    const saveResult = await saveFactsAsMemories(
      facts,
      minQuality,
      verbose ? (current, total) => {
        process.stdout.write(`\rSaving fact ${current}/${total}...`);
      } : undefined
    );

    result.factsSaved = saveResult.saved;
    result.factsSkipped = saveResult.skipped;
    result.errors = saveResult.errors;

    if (verbose) {
      console.log('\n');
    }
  }

  onProgress?.(3, 3, 'complete');

  closeDb();

  return result;
}

/**
 * Run session summary as CLI command
 */
export async function sessionSummary(
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
  const fs = await import('fs');

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
    console.log('Transcript too short for meaningful extraction.');
    return;
  }

  console.log('Extracting session summary...\n');

  const result = await extractSessionSummary(transcript, {
    dryRun: options.dryRun,
    verbose: options.verbose ?? true,
    local: options.local,
    openrouter: options.openrouter,
    apiUrl: options.apiUrl,
    model: options.model,
  });

  console.log('\nSession Summary Results:');
  console.log(`  Facts extracted: ${result.factsExtracted}`);
  console.log(`  Facts saved: ${result.factsSaved}`);
  console.log(`  Facts skipped: ${result.factsSkipped}`);

  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.length}`);
    for (const err of result.errors.slice(0, 3)) {
      console.log(`    - ${err}`);
    }
  }

  // Record token stats if we actually saved facts
  if (result.factsSaved > 0 && result.transcriptTokens && result.summaryTokens) {
    const idleConfig = getIdleReflectionConfig();
    const summaryEnabled = idleConfig.operations?.session_summary ?? true;

    if (summaryEnabled) {
      try {
        const transcriptTokens = countTokens(transcriptContent);
        const savingsTokens = Math.max(0, transcriptTokens - (result.summaryTokens || 0));
        const model = getCurrentModel();
        const estimatedCost = estimateSavings(savingsTokens, model);

        recordTokenStat({
          event_type: 'session_summary',
          query: transcriptPath,
          returned_tokens: result.summaryTokens || 0,
          full_source_tokens: transcriptTokens,
          savings_tokens: savingsTokens,
          chunks_count: result.factsSaved,
          model,
          estimated_cost: estimatedCost,
        });
      } catch {
        // Don't fail if stats recording fails
      }
    }
  }
}

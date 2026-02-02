#!/usr/bin/env node
/**
 * Enhanced Idle Reflection Hook - Sleep-Time Compute
 *
 * Performs multiple operations during Claude's idle time:
 * 1. Memory Consolidation - merge/delete duplicate memories
 * 2. Graph Refinement - auto-link memories by similarity
 * 3. Session Summary - extract key facts (async, detached)
 * 4. Precompute Context - prepare next session (future)
 * 5. Write Reflection - human-like reflection text (async, detached)
 *
 * Heavy LLM operations run as detached processes to not block the session.
 *
 * Fires on Notification event with idle_prompt matcher (after ~60 seconds idle)
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Default config (matches src/lib/config.ts defaults)
const DEFAULT_CONFIG = {
  enabled: true,
  operations: {
    memory_consolidation: true,
    graph_refinement: true,
    session_summary: true,
    precompute_context: false,
    write_reflection: true,
  },
  thresholds: {
    similarity_for_merge: 0.85,
    auto_link_threshold: 0.75,
    min_quality_for_summary: 0.5,
  },
  agent_model: 'haiku',
  sleep_agent: {
    enabled: false,
    mode: 'local',
    model: '',
    api_url: '',
    api_key: '',
    handle_operations: {
      memory_consolidation: true,
      session_summary: true,
      precompute_context: true,
    },
  },
  max_memories_to_process: 50,
  timeout_seconds: 25,
};

/**
 * Load idle reflection config from project or global config
 */
function loadConfig(projectDir) {
  const configPaths = [
    path.join(projectDir, '.succ', 'config.json'),
    path.join(projectDir, '.claude', 'succ.json'), // legacy
  ];

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const idleConfig = config.idle_reflection || {};

        // Merge with defaults
        return {
          enabled: idleConfig.enabled ?? DEFAULT_CONFIG.enabled,
          operations: { ...DEFAULT_CONFIG.operations, ...idleConfig.operations },
          thresholds: { ...DEFAULT_CONFIG.thresholds, ...idleConfig.thresholds },
          agent_model: idleConfig.agent_model ?? DEFAULT_CONFIG.agent_model,
          sleep_agent: {
            ...DEFAULT_CONFIG.sleep_agent,
            ...idleConfig.sleep_agent,
            handle_operations: {
              ...DEFAULT_CONFIG.sleep_agent.handle_operations,
              ...idleConfig.sleep_agent?.handle_operations,
            },
          },
          max_memories_to_process: idleConfig.max_memories_to_process ?? DEFAULT_CONFIG.max_memories_to_process,
          timeout_seconds: idleConfig.timeout_seconds ?? DEFAULT_CONFIG.timeout_seconds,
        };
      } catch {
        // Config parse error, use defaults
      }
    }
  }

  return DEFAULT_CONFIG;
}

/**
 * Run succ CLI command synchronously (for fast operations)
 */
function runSuccCommandSync(projectDir, args, timeout = 10000) {
  try {
    const result = spawnSync('succ', args, {
      cwd: projectDir,
      timeout,
      shell: true,
      encoding: 'utf8',
      windowsHide: true,
    });
    return {
      success: result.status === 0,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  } catch (err) {
    return { success: false, stdout: '', stderr: err.message };
  }
}

/**
 * Run succ CLI command as detached process (for heavy LLM operations)
 * Returns immediately, process continues in background
 */
function runSuccCommandDetached(projectDir, args) {
  try {
    // Note: windowsHide doesn't work with detached on Windows (Node.js bug)
    // Using stdio: 'pipe' instead of 'ignore' may help reduce window flash
    const proc = spawn('succ', args, {
      cwd: projectDir,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    proc.unref(); // Allow parent to exit independently
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Call Sleep Agent (local LLM) via OpenAI-compatible API
 * Used for heavy batch operations when sleep_agent.enabled = true
 *
 * @param {string} prompt - The prompt to send
 * @param {object} sleepAgentConfig - sleep_agent config from idle_reflection
 * @returns {Promise<string|null>} - Response text or null on error
 */
async function callSleepAgent(prompt, sleepAgentConfig) {
  const { mode, model, api_url, api_key } = sleepAgentConfig;

  // Determine API URL based on mode
  let baseUrl = api_url;
  if (!baseUrl) {
    if (mode === 'local') {
      baseUrl = 'http://localhost:11434/v1'; // Ollama default
    } else if (mode === 'openrouter') {
      baseUrl = 'https://openrouter.ai/api/v1';
    }
  }

  if (!baseUrl) {
    return null;
  }

  const endpoint = baseUrl.endsWith('/') ? `${baseUrl}chat/completions` : `${baseUrl}/chat/completions`;

  const headers = {
    'Content-Type': 'application/json',
  };

  if (api_key) {
    headers['Authorization'] = `Bearer ${api_key}`;
  }

  const body = {
    model: model || 'qwen2.5-coder:14b',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 1000,
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000), // 60s timeout
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    return null;
  }
}

/**
 * Check if an operation should use sleep_agent instead of Claude CLI
 */
function shouldUseSleepAgent(config, operation) {
  if (!config.sleep_agent?.enabled) {
    return false;
  }
  return config.sleep_agent.handle_operations?.[operation] === true;
}

/**
 * Memory Consolidation - merge/delete duplicates (sync - fast, no LLM)
 */
function runMemoryConsolidation(projectDir, config) {
  const threshold = config.thresholds.similarity_for_merge;
  const limit = config.max_memories_to_process;

  const result = runSuccCommandSync(projectDir, [
    'consolidate',
    '-t', String(threshold),
    '-n', String(limit),
  ], 15000);

  return result.success;
}

/**
 * Graph Refinement - auto-link memories (sync - fast, no LLM)
 */
function runGraphRefinement(projectDir, config) {
  const threshold = config.thresholds.auto_link_threshold;

  const result = runSuccCommandSync(projectDir, [
    'graph', 'auto-link',
    '-t', String(threshold),
  ], 10000);

  return result.success;
}

/**
 * Session Summary - extract facts (async/detached - uses LLM)
 * Spawns detached process so it doesn't block the session
 * Uses sleep_agent if configured
 */
function runSessionSummaryAsync(projectDir, transcriptPath, config) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }

  const args = ['session-summary', transcriptPath];

  // Add sleep_agent flags if configured
  if (shouldUseSleepAgent(config, 'session_summary')) {
    const sa = config.sleep_agent;
    if (sa.mode === 'local') {
      args.push('--local');
      if (sa.api_url) args.push('--api-url', sa.api_url);
      if (sa.model) args.push('--model', sa.model);
    } else if (sa.mode === 'openrouter') {
      args.push('--openrouter');
      if (sa.model) args.push('--model', sa.model);
    }
  }

  return runSuccCommandDetached(projectDir, args);
}

/**
 * Write Reflection - generate reflection text (async/detached - uses LLM)
 * Spawns detached process so it doesn't block the session
 * Uses sleep_agent if configured, otherwise falls back to Claude CLI
 */
function writeReflectionAsync(projectDir, transcriptContext, config) {
  // Write transcript context to temp file for the detached process
  const tempDir = path.join(projectDir, '.succ', '.tmp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const contextFile = path.join(tempDir, `reflection-context-${Date.now()}.txt`);
  fs.writeFileSync(contextFile, transcriptContext);

  const reflectionsDir = path.join(projectDir, '.succ', 'brain', 'reflections');

  // Create reflections directory if needed
  if (!fs.existsSync(reflectionsDir)) {
    fs.mkdirSync(reflectionsDir, { recursive: true });
  }

  // Determine which agent to use
  const useSleepAgent = shouldUseSleepAgent(config, 'write_reflection');
  const sleepAgentConfig = config.sleep_agent || {};
  const claudeModel = config.agent_model || 'haiku';

  // Spawn a detached node process that does the actual reflection
  const scriptContent = `
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const contextFile = ${JSON.stringify(contextFile)};
const reflectionsDir = ${JSON.stringify(reflectionsDir)};
const projectDir = ${JSON.stringify(projectDir)};
const useSleepAgent = ${useSleepAgent};
const sleepAgentConfig = ${JSON.stringify(sleepAgentConfig)};
const claudeModel = ${JSON.stringify(claudeModel)};

const transcriptContext = fs.readFileSync(contextFile, 'utf8');

const now = new Date();
const dateStr = now.toISOString().split('T')[0];
const timeStr = now.toTimeString().split(' ')[0].substring(0, 5).replace(':', '-');
const timestamp = dateStr + '_' + timeStr;

const prompt = \`You are writing a brief personal reflection for an AI's internal journal.

Session context (recent conversation):
---
\${transcriptContext.substring(0, 3000)}
---

Write a short reflection (3-5 sentences) about this session. Be honest and introspective.
Consider:
- What was accomplished or attempted?
- Any interesting challenges or discoveries?
- What might be worth remembering for future sessions?

Output ONLY the reflection text, no headers or formatting. Write in first person as if you are the AI reflecting on your own work.\`;

function writeReflection(text) {
  if (!text || text.trim().length < 50) return;

  // Create individual reflection file with YAML frontmatter
  const reflectionFile = path.join(reflectionsDir, timestamp + '.md');
  const content = \`---
date: \${dateStr}
time: \${timeStr.replace('-', ':')}
trigger: idle
tags:
  - reflection
---

# Reflection \${dateStr} \${timeStr.replace('-', ':')}

\${text.trim()}
\`;

  fs.writeFileSync(reflectionFile, content);

  // Save to memory via succ remember
  try {
    const { spawnSync } = require('child_process');
    spawnSync('npx', ['succ', 'remember', text.trim(), '--tags', 'reflection', '--source', 'idle-reflection'], {
      cwd: projectDir,
      timeout: 10000,
      shell: true,
      windowsHide: true,
    });
  } catch {
    // Memory save failed, but file was written
  }
}

async function callSleepAgentLocal(prompt) {
  const { mode, model, api_url, api_key } = sleepAgentConfig;

  let baseUrl = api_url;
  if (!baseUrl) {
    if (mode === 'local') baseUrl = 'http://localhost:11434/v1';
    else if (mode === 'openrouter') baseUrl = 'https://openrouter.ai/api/v1';
  }
  if (!baseUrl) return null;

  const endpoint = baseUrl.endsWith('/') ? baseUrl + 'chat/completions' : baseUrl + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (api_key) headers['Authorization'] = 'Bearer ' + api_key;

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
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch { return null; }
}

const scriptFile = ${JSON.stringify(scriptFile)};

async function main() {
  try { fs.unlinkSync(contextFile); } catch {}

  // Cleanup function to delete script file on exit
  const cleanup = () => {
    try { fs.unlinkSync(scriptFile); } catch {}
  };
  process.on('exit', cleanup);

  if (useSleepAgent) {
    // Use local LLM via sleep_agent
    const result = await callSleepAgentLocal(prompt);
    if (result) {
      writeReflection(result);
    }
    process.exit(0);
  } else {
    // Use Claude CLI
    const proc = spawn('claude', ['-p', '--tools', '', '--model', claudeModel], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      windowsHide: true,
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) writeReflection(stdout);
      process.exit(0);
    });

    proc.on('error', () => { process.exit(1); });

    setTimeout(() => { proc.kill(); process.exit(1); }, 60000);
  }
}

main();
`;

  const scriptFile = path.join(tempDir, `reflection-script-${Date.now()}.cjs`);
  fs.writeFileSync(scriptFile, scriptContent);

  try {
    // Note: windowsHide doesn't work with detached on Windows (Node.js bug)
    // Using stdio: 'pipe' and process.execPath for better compatibility
    const proc = spawn(process.execPath, [scriptFile], {
      cwd: projectDir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    proc.unref();
    // Script file will be deleted by the detached process on exit
    return true;
  } catch (err) {
    try { fs.unlinkSync(scriptFile); } catch {}
    try { fs.unlinkSync(contextFile); } catch {}
    return false;
  }
}

/**
 * Extract transcript context from hook input
 */
function extractTranscriptContext(hookInput) {
  if (!hookInput.transcript_path || !fs.existsSync(hookInput.transcript_path)) {
    return '';
  }

  try {
    const transcriptContent = fs.readFileSync(hookInput.transcript_path, 'utf8');
    const lines = transcriptContent.trim().split('\n');
    const recentLines = lines.slice(-20);

    return recentLines
      .map(line => {
        try {
          const entry = JSON.parse(line);
          const getTextContent = (content) => {
            if (typeof content === 'string') return content;
            if (Array.isArray(content)) {
              return content
                .filter(block => block.type === 'text' && block.text)
                .map(block => block.text)
                .join(' ');
            }
            return '';
          };

          if (entry.type === 'assistant' && entry.message?.content) {
            const text = getTextContent(entry.message.content);
            if (text) return 'Assistant: ' + text.substring(0, 500);
          }
          if ((entry.type === 'human' || entry.type === 'user') && entry.message?.content) {
            const text = getTextContent(entry.message.content);
            if (text) return 'User: ' + text.substring(0, 300);
          }
        } catch {
          return null;
        }
        return null;
      })
      .filter(Boolean)
      .join('\n\n');
  } catch {
    return '';
  }
}

// Main execution
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('readable', () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    input += chunk;
  }
});

process.stdin.on('end', () => {
  try {
    const hookInput = JSON.parse(input);
    let projectDir = hookInput.cwd || process.cwd();

    // Convert /c/... to C:/... on Windows if needed
    if (process.platform === 'win32' && /^\/[a-z]\//.test(projectDir)) {
      projectDir = projectDir[1].toUpperCase() + ':' + projectDir.slice(2);
    }

    // Load config
    const config = loadConfig(projectDir);

    // Check if idle reflection is enabled
    if (!config.enabled) {
      process.exit(0);
    }

    // === SYNC OPERATIONS (fast, no LLM) ===
    // These run synchronously and complete before hook exits

    // 1. Memory Consolidation (sync)
    if (config.operations.memory_consolidation) {
      runMemoryConsolidation(projectDir, config);
    }

    // 2. Graph Refinement (sync)
    if (config.operations.graph_refinement) {
      runGraphRefinement(projectDir, config);
    }

    // === ASYNC OPERATIONS (slow, uses LLM) ===
    // These spawn detached processes and complete in background
    // Hook exits immediately, processes continue independently

    // 3. Session Summary (async/detached)
    if (config.operations.session_summary && hookInput.transcript_path) {
      runSessionSummaryAsync(projectDir, hookInput.transcript_path, config);
    }

    // 4. Write Reflection (async/detached)
    if (config.operations.write_reflection) {
      const transcriptContext = extractTranscriptContext(hookInput);
      if (transcriptContext && transcriptContext.length >= 100) {
        writeReflectionAsync(projectDir, transcriptContext, config);
      }
    }

    // 5. Precompute Context (async/detached)
    if (config.operations.precompute_context && hookInput.transcript_path) {
      const precomputeArgs = ['precompute-context', hookInput.transcript_path];

      // Add sleep_agent flags if configured
      if (shouldUseSleepAgent(config, 'precompute_context')) {
        const sa = config.sleep_agent;
        if (sa.mode === 'local') {
          precomputeArgs.push('--local');
          if (sa.api_url) precomputeArgs.push('--api-url', sa.api_url);
          if (sa.model) precomputeArgs.push('--model', sa.model);
        } else if (sa.mode === 'openrouter') {
          precomputeArgs.push('--openrouter');
          if (sa.model) precomputeArgs.push('--model', sa.model);
        }
      }

      runSuccCommandDetached(projectDir, precomputeArgs);
    }

    // Exit immediately - detached processes continue in background
    process.exit(0);

  } catch (err) {
    // Silent failure - hooks shouldn't break the session
    process.exit(0);
  }
});

// Global timeout (safety net)
setTimeout(() => {
  process.exit(0);
}, 5000); // Reduced since heavy ops are now detached

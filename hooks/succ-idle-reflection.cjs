#!/usr/bin/env node
/**
 * Enhanced Idle Reflection Hook - Sleep-Time Compute
 *
 * Performs multiple operations during Claude's idle time:
 * 1. Memory Consolidation - merge/delete duplicate memories
 * 2. Graph Refinement - auto-link memories by similarity
 * 3. Session Summary - extract key facts (future)
 * 4. Precompute Context - prepare next session (future)
 * 5. Write Reflection - human-like reflection text
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
 * Run succ CLI command synchronously
 */
function runSuccCommand(projectDir, args, timeout = 10000) {
  try {
    const result = spawnSync('succ', args, {
      cwd: projectDir,
      timeout,
      shell: true,
      encoding: 'utf8',
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
 * Memory Consolidation - merge/delete duplicates
 */
function runMemoryConsolidation(projectDir, config) {
  const threshold = config.thresholds.similarity_for_merge;
  const limit = config.max_memories_to_process;

  const result = runSuccCommand(projectDir, [
    'consolidate',
    '-t', String(threshold),
    '-n', String(limit),
  ], 15000);

  return result.success;
}

/**
 * Graph Refinement - auto-link memories
 */
function runGraphRefinement(projectDir, config) {
  const threshold = config.thresholds.auto_link_threshold;

  const result = runSuccCommand(projectDir, [
    'graph', 'auto-link',
    '-t', String(threshold),
  ], 10000);

  return result.success;
}

/**
 * Session Summary - extract facts from transcript and save as memories
 */
function runSessionSummary(projectDir, transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }

  const result = runSuccCommand(projectDir, [
    'session-summary',
    transcriptPath,
  ], 45000); // Allow more time for LLM extraction

  return result.success;
}

/**
 * Write Reflection - generate reflection text via Claude
 */
function writeReflection(projectDir, transcriptContext, config) {
  return new Promise((resolve) => {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].substring(0, 5);

    const reflectionsPath = path.join(projectDir, '.succ', 'brain', '.self', 'reflections.md');
    const selfDir = path.dirname(reflectionsPath);

    if (!fs.existsSync(selfDir)) {
      fs.mkdirSync(selfDir, { recursive: true });
    }

    const prompt = `You are writing a brief personal reflection for an AI's internal journal.

Session context (recent conversation):
---
${transcriptContext.substring(0, 3000)}
---

Write a short reflection (3-5 sentences) about this session. Be honest and introspective.
Consider:
- What was accomplished or attempted?
- Any interesting challenges or discoveries?
- What might be worth remembering for future sessions?

Output ONLY the reflection text, no headers or formatting. Write in first person as if you are the AI reflecting on your own work.`;

    const model = config.agent_model || 'haiku';
    const proc = spawn('claude', ['-p', '--tools', '', '--model', model], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      cwd: projectDir,
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = '';
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0 && stdout.trim() && stdout.trim().length > 50) {
        const existingContent = fs.existsSync(reflectionsPath)
          ? fs.readFileSync(reflectionsPath, 'utf8')
          : '# Reflections\n\nInternal dialogue between sessions.\n';

        const reflectionEntry = `
## ${dateStr} ${timeStr} (idle pause)

${stdout.trim()}

---
`;

        fs.writeFileSync(reflectionsPath, existingContent + reflectionEntry);
        resolve(true);
      } else {
        resolve(false);
      }
    });

    proc.on('error', () => {
      resolve(false);
    });

    // Timeout for reflection
    setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 20000);
  });
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

process.stdin.on('end', async () => {
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

    // Track what we did
    const results = {
      consolidation: null,
      graph: null,
      sessionSummary: null,
      reflection: null,
    };

    // 1. Memory Consolidation
    if (config.operations.memory_consolidation) {
      results.consolidation = runMemoryConsolidation(projectDir, config);
    }

    // 2. Graph Refinement
    if (config.operations.graph_refinement) {
      results.graph = runGraphRefinement(projectDir, config);
    }

    // 3. Session Summary (extract facts from transcript)
    if (config.operations.session_summary && hookInput.transcript_path) {
      results.sessionSummary = runSessionSummary(projectDir, hookInput.transcript_path);
    }

    // 4. Write Reflection (needs transcript context)
    if (config.operations.write_reflection) {
      const transcriptContext = extractTranscriptContext(hookInput);

      if (transcriptContext && transcriptContext.length >= 100) {
        results.reflection = await writeReflection(projectDir, transcriptContext, config);
      }
    }

    // TODO: Precompute Context (requires LLM call to prepare context)

    process.exit(0);

  } catch (err) {
    // Silent failure - hooks shouldn't break the session
    process.exit(0);
  }
});

// Global timeout
setTimeout(() => {
  process.exit(0);
}, 28000);

#!/usr/bin/env node
/**
 * UserPromptSubmit Hook - Smart Memory Recall
 *
 * Two modes:
 * 1. FAST PATH: Log prompt, check for explicit memory commands
 * 2. SMART PATH: Detect memory-seeking patterns and inject relevant memories
 *
 * Triggers on:
 * - Explicit: "check memory", "what do you remember", "напомни"
 * - Questions about past: "why did we", "what was decided", "last time"
 * - Context requests: "bring me up to speed", "background on"
 *
 * Uses execFileSync for security (no shell injection)
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

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

    // Windows path fix
    if (process.platform === 'win32' && /^\/[a-z]\//.test(projectDir)) {
      projectDir = projectDir[1].toUpperCase() + ':' + projectDir.slice(2);
    }

    const tmpDir = path.join(projectDir, '.succ', '.tmp');

    // Get session_id from transcript_path (unique per session)
    const transcriptPath = hookInput.transcript_path || '';
    const sessionId = transcriptPath ? path.basename(transcriptPath, '.jsonl') : null;

    // Read daemon port
    let daemonPort = null;
    try {
      const portFile = path.join(tmpDir, 'daemon.port');
      if (fs.existsSync(portFile)) {
        daemonPort = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
      }
    } catch {}

    // Check if this is a service session (e.g., reflection subagent)
    const isServiceSession = process.env.SUCC_SERVICE_SESSION === '1';

    // Notify daemon of user activity (awaited)
    const notifyDaemon = async () => {
      if (!daemonPort || !sessionId) return;

      try {
        await fetch(`http://127.0.0.1:${daemonPort}/api/session/activity`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            type: 'user_prompt',
            transcript_path: transcriptPath,
            is_service: isServiceSession,
          }),
          signal: AbortSignal.timeout(2000),
        });
      } catch {}
    };

    // Start daemon notification
    const daemonPromise = notifyDaemon();

    const prompt = hookInput.prompt || hookInput.message || '';
    if (!prompt || prompt.length < 5) {
      await daemonPromise;
      process.exit(0);
    }

    const promptLower = prompt.toLowerCase();

    // Explicit memory commands
    const explicitMemoryCommands = [
      /\bcheck\s+(the\s+)?memor(y|ies)\b/i,
      /\bsearch\s+(the\s+)?memor(y|ies)\b/i,
      /\bwhat\s+do\s+you\s+remember\b/i,
      /\brecall\s+(everything|all)\b/i,
    ];

    const isExplicitMemoryCommand = explicitMemoryCommands.some((p) => p.test(promptLower));

    // Memory-seeking patterns
    const memorySeekingPatterns = [
      /\bwhy\s+did\s+(we|i|you)\b/i,
      /\bwhat\s+was\s+the\s+reason\b/i,
      /\bwhat\s+decision\b/i,
      /\blast\s+(time|session)\b/i,
      /\bpreviously\b/i,
      /\b(we|i)\s+(discussed|talked|decided|agreed)\b/i,
      /\bbring\s+me\s+up\s+to\s+speed\b/i,
      /\bcatch\s+me\s+up\b/i,
    ];

    const isMemorySeeking = memorySeekingPatterns.some((p) => p.test(promptLower));

    if (!isExplicitMemoryCommand && !isMemorySeeking) {
      await daemonPromise;
      process.exit(0);
    }

    // Extract search query
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
      'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him',
      'what', 'which', 'who', 'where', 'when', 'why', 'how',
      'and', 'but', 'or', 'so', 'if', 'then', 'than', 'because',
    ]);

    const words = prompt
      .toLowerCase()
      .replace(/[^\w\s]/gi, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));

    const searchQuery = words.slice(0, 6).join(' ');

    if (!searchQuery || searchQuery.length < 3) {
      await daemonPromise;
      process.exit(0);
    }

    // Search memories
    const contextParts = [];

    try {
      const result = execFileSync(
        'npx',
        ['succ', 'memories', '--search', searchQuery, '--limit', '3'],
        {
          cwd: projectDir,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: true,
        }
      );

      if (result.trim() && !result.includes('No memories found')) {
        contextParts.push(result.trim());
      }
    } catch {
      // Memory search failed
    }

    // For explicit commands, also search brain vault
    if (isExplicitMemoryCommand) {
      try {
        const brainResult = execFileSync(
          'npx',
          ['succ', 'search', searchQuery, '--limit', '2'],
          {
            cwd: projectDir,
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true,
          }
        );

        if (brainResult.trim() && !brainResult.includes('No results')) {
          contextParts.push('\n--- From Knowledge Base ---\n' + brainResult.trim());
        }
      } catch {
        // Brain search failed
      }
    }

    if (contextParts.length > 0) {
      const triggerType = isExplicitMemoryCommand ? 'explicit-command' : 'pattern-detected';
      const output = {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `<memory-recall trigger="${triggerType}" query="${searchQuery}">\n${contextParts.join('\n')}\n</memory-recall>`,
        },
      };
      console.log(JSON.stringify(output));
    }

    await daemonPromise;
    process.exit(0);
  } catch (err) {
    process.exit(0);
  }
});

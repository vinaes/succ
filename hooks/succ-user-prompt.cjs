#!/usr/bin/env node
/**
 * UserPromptSubmit Hook - Notify daemon of user activity
 *
 * Used for idle detection - tracks when user sends prompts
 * so daemon knows session is active.
 *
 * NOTE: Auto-recall logic is disabled. Claude can use succ_recall MCP tool
 * when it needs memory context - it's smarter than regex pattern matching.
 */

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

    // Skip if succ is not initialized in this project
    if (!fs.existsSync(path.join(projectDir, '.succ'))) {
      process.exit(0);
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

    // Notify daemon of user activity
    if (daemonPort && sessionId) {
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
    }

    // --- Auto-recall disabled ---
    // Claude can use succ_recall MCP tool when it needs memory context.
    // Pattern-based auto-injection was removed because:
    // 1. Claude is smarter at knowing when it needs memory
    // 2. Avoids duplicate context if Claude also calls recall
    // 3. Reduces latency on every prompt
    //
    // To re-enable, uncomment the code below:
    /*
    const prompt = hookInput.prompt || hookInput.message || '';
    const promptLower = prompt.toLowerCase();

    const explicitMemoryCommands = [
      /\bcheck\s+(the\s+)?memor(y|ies)\b/i,
      /\bsearch\s+(the\s+)?memor(y|ies)\b/i,
      /\bwhat\s+do\s+you\s+remember\b/i,
      /\brecall\s+(everything|all)\b/i,
    ];

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

    const isExplicitMemoryCommand = explicitMemoryCommands.some((p) => p.test(promptLower));
    const isMemorySeeking = memorySeekingPatterns.some((p) => p.test(promptLower));

    if (isExplicitMemoryCommand || isMemorySeeking) {
      // Extract search query and call daemon API...
    }
    */

    process.exit(0);
  } catch (err) {
    process.exit(0);
  }
});

#!/usr/bin/env node
/**
 * SessionEnd Hook - Auto-summarize session to succ memory + brain vault
 *
 * Actions:
 * 1. Save session summary to SQLite memory (succ remember)
 * 2. Use Claude CLI to extract learnings and append to .succ/brain/.meta/learnings.md
 * 3. Create session note in .succ/brain/00_Inbox/
 *
 * Uses process.execPath to find node and handles cross-platform paths
 */

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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
    // Normalize the path for the current platform
    let projectDir = hookInput.cwd || process.cwd();
    // Convert /c/... to C:/... on Windows if needed
    if (process.platform === 'win32' && /^\/[a-z]\//.test(projectDir)) {
      projectDir = projectDir[1].toUpperCase() + ':' + projectDir.slice(2);
    }

    // Unregister session from daemon (triggers final reflection)
    const tmpDir = path.join(projectDir, '.succ', '.tmp');
    const portFile = path.join(tmpDir, 'daemon.port');

    // Get session_id from transcript_path (unique per session)
    const transcriptPath = hookInput.transcript_path || '';
    const sessionId = transcriptPath ? path.basename(transcriptPath, '.jsonl') : null;

    // Read daemon port
    let daemonPort = null;
    try {
      if (fs.existsSync(portFile)) {
        daemonPort = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
      }
    } catch {}

    // Async function to unregister from daemon
    const unregisterFromDaemon = async () => {
      if (!sessionId || !daemonPort) return;

      try {
        await fetch(`http://127.0.0.1:${daemonPort}/api/session/unregister`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, run_reflection: true }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Daemon communication failed
      }
    };

    // Start daemon unregistration (will complete async)
    const daemonUnregisterPromise = unregisterFromDaemon();

    // SessionEnd hook receives: { transcript_summary, ... }
    const summary = hookInput.transcript_summary || hookInput.session_summary;

    if (!summary || summary.length < 50) {
      // Session too short or no summary - still unregister from daemon, then exit
      daemonUnregisterPromise.finally(() => process.exit(0));
      return;
    }

    // Extract key info from session
    const now = new Date();
    const sessionDate = now.toISOString().split('T')[0];
    const sessionTime = now.toTimeString().split(' ')[0].substring(0, 5);
    const tags = ['session'];

    // Detect session type from content
    const isBugfix = /fix|bug|error|issue|solved|debugging/i.test(summary);
    const isFeature = /feature|implement|add|create|built/i.test(summary);
    const isRefactor = /refactor|clean|improve|reorganize/i.test(summary);
    const isDecision = /decision|decide|choose|chose|went with/i.test(summary);

    if (isBugfix) tags.push('bugfix');
    if (isFeature) tags.push('feature');
    if (isRefactor) tags.push('refactor');
    if (isDecision) tags.push('decision');

    // Truncate if too long (keep first 2000 chars)
    let content = summary.length > 2000
      ? summary.substring(0, 2000) + '...'
      : summary;

    // Clean content for memory (newlines to spaces)
    const memoryContent = content.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

    // Brain vault paths
    const brainDir = path.join(projectDir, '.succ', 'brain');
    const learningsPath = path.join(brainDir, '.meta', 'learnings.md');
    const inboxDir = path.join(brainDir, '00_Inbox');

    // 1. Save to SQLite memory via succ
    try {
      spawnSync('npx', [
        'succ',
        'remember',
        memoryContent,
        '--tags', tags.join(','),
        '--source', 'session-' + sessionDate
      ], {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        windowsHide: true,
      });
    } catch {
      // Failed to save to memory, continue
    }

    // 2. Use Claude CLI to extract learnings
    if (fs.existsSync(learningsPath) && content.length > 100) {
      const learningsPrompt = `Analyze this development session summary and extract any learnings worth remembering.

Session summary:
---
${content}
---

Extract ONLY concrete, reusable learnings such as:
- Bug fixes: what was wrong and how it was fixed
- Technical discoveries: APIs, patterns, gotchas
- Architecture decisions and their rationale
- Workarounds found for specific problems

If there are NO meaningful learnings (just routine work), output exactly: NONE

Otherwise, output learnings as a bullet list, one learning per line starting with "- ".
Each learning should be a complete, standalone statement that will be useful in the future.
Keep each bullet concise (1-2 sentences max).`;

      const proc = spawn('claude', ['-p', '--tools', '', '--model', 'haiku'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        cwd: projectDir,
        windowsHide: true,
        env: { ...process.env, SUCC_SERVICE_SESSION: '1' },
      });

      proc.stdin.write(learningsPrompt);
      proc.stdin.end();

      let stdout = '';
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 && stdout.trim() && !stdout.trim().toUpperCase().includes('NONE')) {
          try {
            const existingContent = fs.readFileSync(learningsPath, 'utf8');
            const newEntry = '\n\n## ' + sessionDate + '\n\n' + stdout.trim();
            fs.writeFileSync(learningsPath, existingContent + newEntry);
          } catch {
            // Failed to write learnings
          }
        }
        finishHook();
      });

      proc.on('error', () => {
        finishHook();
      });

      // Timeout after 12 seconds (hook timeout is 15)
      setTimeout(() => {
        proc.kill();
        finishHook();
      }, 12000);

    } else {
      finishHook();
    }

    async function finishHook() {
      // 3. Create session note in Inbox
      if (fs.existsSync(inboxDir)) {
        try {
          const sessionTitle = generateSessionTitle(summary, tags);
          const safeTitle = sessionTitle.replace(/[<>:"/\\|?*]/g, '').substring(0, 50);
          const sessionNotePath = path.join(inboxDir, 'Session ' + sessionDate + ' ' + safeTitle + '.md');

          // Only create if doesn't exist (avoid duplicates)
          if (!fs.existsSync(sessionNotePath)) {
            const noteContent = `---
description: "Session notes from ${sessionDate}"
type: session
tags: [${tags.map(t => '"' + t + '"').join(', ')}]
date: ${sessionDate}
---

# Session: ${sessionTitle}

**Date:** ${sessionDate} ${sessionTime}
**Tags:** ${tags.join(', ')}

## Summary

${content}

---

*Auto-generated by succ session-end hook*
`;
            fs.writeFileSync(sessionNotePath, noteContent);
          }
        } catch {
          // Failed to create session note, continue
        }
      }

      // Wait for daemon unregistration to complete before exiting
      await daemonUnregisterPromise;
      process.exit(0);
    }
  } catch (err) {
    process.exit(0);
  }
});

/**
 * Generate a short descriptive title from session summary
 */
function generateSessionTitle(summary, tags) {
  // Try to extract key action/topic from summary
  const actionPatterns = [
    /(?:implemented|added|created|built|fixed|refactored|updated|improved)\s+([^.,!?]+)/i,
    /(?:working on|session about|focused on)\s+([^.,!?]+)/i,
  ];

  for (const pattern of actionPatterns) {
    const match = summary.match(pattern);
    if (match && match[1]) {
      return match[1].trim().substring(0, 40);
    }
  }

  // Fallback: use tags
  if (tags.includes('bugfix')) return 'Bug Fix';
  if (tags.includes('feature')) return 'Feature Work';
  if (tags.includes('refactor')) return 'Refactoring';
  if (tags.includes('decision')) return 'Decisions';

  return 'Development';
}

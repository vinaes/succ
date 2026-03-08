#!/usr/bin/env node
/**
 * UserPromptSubmit Hook - Notify daemon of user activity
 *
 * Used for:
 * 1. Idle detection - tracks when user sends prompts
 * 2. Compact fallback - re-injects context if SessionStart output was lost
 *
 * NOTE: Auto-recall logic is disabled. Claude can use succ_recall MCP tool
 * when it needs memory context - it's smarter than regex pattern matching.
 */

const path = require('path');
const fs = require('fs');
const adapter = require('./core/adapter.cjs');

// Logging helper - writes to .succ/.tmp/hooks.log
function log(succDir, message) {
  try {
    const tmpDir = path.join(succDir, '.tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    const logFile = path.join(tmpDir, 'hooks.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] [user-prompt] ${message}\n`);
  } catch {
    // intentionally empty — logging failed, not critical
  }
}

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
    const rawInput = JSON.parse(input);
    const agent = adapter.detectAgent(rawInput);
    const hookInput = adapter.normalizeInput(agent, rawInput);
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
    } catch {
      // intentionally empty
    }

    // Check if this is a service session (e.g., reflection subagent)
    const isServiceSession = process.env.SUCC_SERVICE_SESSION === '1';

    const succDir = path.join(projectDir, '.succ');

    // Check for compact-pending fallback
    // This handles the case where SessionStart hook output was lost after /compact
    // See: https://github.com/anthropics/claude-code/issues/15174
    const compactPendingFile = path.join(tmpDir, 'compact-pending');
    if (fs.existsSync(compactPendingFile) && !isServiceSession) {
      try {
        const pendingContext = fs.readFileSync(compactPendingFile, 'utf8');
        // Delete the file before outputting to avoid duplicate injection
        fs.unlinkSync(compactPendingFile);

        if (pendingContext.trim()) {
          log(succDir, `Injecting compact-pending fallback context (${pendingContext.length} chars)`);

          // Output as additionalContext - this will be injected into the agent's context
          const { json, exitCode } = adapter.formatOutput(agent, 'UserPromptSubmit', {
            additionalContext: `<compact-fallback reason="SessionStart output may have been lost">\n${pendingContext}\n</compact-fallback>`
          });
          if (json && Object.keys(json).length > 0) {
            console.log(JSON.stringify(json));
          }
          if (exitCode) process.exit(exitCode);
        }
      } catch (err) {
        log(succDir, `Error processing compact-pending: ${err.message || err}`);
      }
    }

    // Notify daemon of user activity
    let daemonAlive = false;
    if (daemonPort && sessionId) {
      try {
        const res = await fetch(`http://127.0.0.1:${daemonPort}/api/session/activity`, {
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
        if (res.ok) daemonAlive = true;
      } catch {
        // intentionally empty — daemon not reachable
      }
    }

    // --- Skill Suggestions ---
    // LLM-powered skill suggestions based on user prompt.
    // Uses extractKeywords → BM25 search → LLM ranking.
    // Respects cooldown to avoid suggesting on every prompt.
    if (daemonAlive && !isServiceSession) {
      const prompt = hookInput.prompt || hookInput.message || '';

      // Load config to check if auto_suggest is enabled
      let skillsConfig = null;
      const configPaths = [
        path.join(succDir, 'config.json'),
        path.join(require('os').homedir(), '.succ', 'config.json'),
      ];
      for (const configPath of configPaths) {
        if (fs.existsSync(configPath)) {
          try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (config.skills) {
              skillsConfig = config.skills;
              break;
            }
          } catch {
            // intentionally empty — ignore parse errors
          }
        }
      }

      // Defaults
      const autoSuggest = skillsConfig?.auto_suggest || {};
      const enabled = autoSuggest.enabled === true; // default: false (matches skills.ts)
      const onUserPrompt = autoSuggest.on_user_prompt !== false; // default: true
      const minPromptLength = autoSuggest.min_prompt_length || 20;
      const cooldownPrompts = autoSuggest.cooldown_prompts || 3;

      if (enabled && onUserPrompt && prompt.length >= minPromptLength) {
        // Check cooldown (track prompts since last suggestion per session)
        const cooldownFile = path.join(tmpDir, `skill-cooldown-${sessionId}`);
        let promptsSinceLastSuggestion = 0;

        try {
          if (fs.existsSync(cooldownFile)) {
            promptsSinceLastSuggestion = parseInt(fs.readFileSync(cooldownFile, 'utf8').trim(), 10) || 0;
          }
        } catch {
          // intentionally empty
        }

        // Only suggest if cooldown has passed
        if (promptsSinceLastSuggestion >= cooldownPrompts || promptsSinceLastSuggestion === 0) {
          try {
            const response = await fetch(`http://127.0.0.1:${daemonPort}/api/skills/suggest`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt }),
              signal: AbortSignal.timeout(15000), // 15s timeout for 2 LLM calls (extraction + ranking)
            });

            if (response.ok) {
              const data = await response.json();
              const suggestions = data.skills || [];

              if (suggestions.length > 0) {
                // Reset cooldown counter
                fs.writeFileSync(cooldownFile, '0', 'utf8');

                // Format suggestions
                const lines = suggestions.map((s) => {
                  return `- **${s.name}**: ${s.reason} (confidence: ${(s.confidence * 100).toFixed(0)}%)`;
                });

                const suggestionContext = `<skill-suggestions hint="Use /${suggestions[0].name} to invoke">\n${lines.join('\n')}\n</skill-suggestions>`;

                log(succDir, `Suggesting ${suggestions.length} skill(s): ${suggestions.map(s => s.name).join(', ')}`);

                // Output as additionalContext
                const { json: sugJson, exitCode: sugExitCode } = adapter.formatOutput(agent, 'UserPromptSubmit', {
                  additionalContext: suggestionContext
                });
                if (sugJson && Object.keys(sugJson).length > 0) {
                  console.log(JSON.stringify(sugJson));
                }
                if (sugExitCode) process.exit(sugExitCode);
              } else {
                // No suggestions, increment cooldown
                fs.writeFileSync(cooldownFile, String(promptsSinceLastSuggestion + 1), 'utf8');
              }
            }
          } catch (err) {
            log(succDir, `Skill suggestion error: ${err.message || err}${err.cause ? ' | cause: ' + (err.cause.message || err.cause) : ''} | port=${daemonPort}`);
          }
        } else {
          // Cooldown not passed, increment counter
          try {
            fs.writeFileSync(cooldownFile, String(promptsSinceLastSuggestion + 1), 'utf8');
          } catch {
            // intentionally empty
          }
        }
      }
    }

    process.exit(0);
  } catch {
    // intentionally empty
    process.exit(0);
  }
});

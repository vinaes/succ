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
const { getDaemonPort } = require('./core/daemon-boot.cjs');
const { log: _log } = require('./core/log.cjs');
const { loadMergedConfig } = require('./core/config.cjs');

adapter.runHook('user-prompt', async ({ agent, hookInput, projectDir, succDir }) => {
  const log = (msg) => _log(succDir, 'user-prompt', msg);

  const tmpDir = path.join(succDir, '.tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  // Get session_id from transcript_path (unique per session)
  const transcriptPath = hookInput.transcript_path || '';
  const sessionId = transcriptPath ? path.basename(transcriptPath, '.jsonl') : null;

  const daemonPort = getDaemonPort(succDir);

  // Check if this is a service session (e.g., reflection subagent)
  const isServiceSession = process.env.SUCC_SERVICE_SESSION === '1';

  // Collect all context parts — output a single JSON at the end to avoid broken hook parsing
  const contextParts = [];

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
        log(`Injecting compact-pending fallback context (${pendingContext.length} chars)`);
        contextParts.push(
          `<compact-fallback reason="SessionStart output may have been lost">\n${pendingContext}\n</compact-fallback>`
        );
      }
    } catch (err) {
      log(`Error processing compact-pending: ${err.message || err}`);
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
    } catch (e) {
      log(`Daemon activity notification failed: ${e.message || e}`);
    }
  }

  // --- Skill Suggestions ---
  // LLM-powered skill suggestions based on user prompt.
  // Uses extractKeywords → BM25 search → LLM ranking.
  // Respects cooldown to avoid suggesting on every prompt.
  if (daemonAlive && !isServiceSession) {
    const prompt = hookInput.prompt || hookInput.message || '';

    // Load config to check if auto_suggest is enabled
    const config = loadMergedConfig(projectDir);
    const skillsConfig = config.skills || null;

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
          promptsSinceLastSuggestion =
            parseInt(fs.readFileSync(cooldownFile, 'utf8').trim(), 10) || 0;
        }
      } catch (e) {
        log(`Cooldown file read failed: ${e.message || e}`);
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

              log(
                `Suggesting ${suggestions.length} skill(s): ${suggestions.map((s) => s.name).join(', ')}`
              );

              contextParts.push(suggestionContext);
            } else {
              // No suggestions, increment cooldown
              fs.writeFileSync(cooldownFile, String(promptsSinceLastSuggestion + 1), 'utf8');
            }
          }
        } catch (err) {
          log(
            `Skill suggestion error: ${err.message || err}${err.cause ? ' | cause: ' + (err.cause.message || err.cause) : ''} | port=${daemonPort}`
          );
        }
      } else {
        // Cooldown not passed, increment counter
        try {
          fs.writeFileSync(cooldownFile, String(promptsSinceLastSuggestion + 1), 'utf8');
        } catch (e) {
          log(`Cooldown file write failed: ${e.message || e}`);
        }
      }
    }
  }

  // Emit a single hook payload with all collected context
  if (contextParts.length > 0) {
    const { json, exitCode } = adapter.formatOutput(agent, 'UserPromptSubmit', {
      additionalContext: contextParts.join('\n\n'),
    });
    if (json && Object.keys(json).length > 0) {
      console.log(JSON.stringify(json));
    }
    if (exitCode) process.exit(exitCode);
  }

  process.exit(0);
});

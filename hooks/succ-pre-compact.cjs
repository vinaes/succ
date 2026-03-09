#!/usr/bin/env node
/**
 * PreCompact Hook — Session Analysis Before Compaction
 *
 * Fires before Claude Code compacts the context (auto or manual /compact).
 * Analyzes the transcript JSONL to produce token breakdown stats and saves
 * them to .succ/.tmp/ for the post-compact SessionStart hook to display.
 *
 * Constraints:
 * - MUST be CJS (PreCompact only supports command hooks, not HTTP)
 * - MUST be fast (< 2s) — pure I/O char counting, no LLM
 * - Cannot import ESM modules — analysis logic is inlined
 */

const fs = require('fs');
const path = require('path');
const adapter = require('./core/adapter.cjs');

// Logging helper
function log(succDir, message) {
  try {
    const tmpDir = path.join(succDir, '.tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const logFile = path.join(tmpDir, 'hooks.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] [pre-compact] ${message}\n`);
  } catch {
    // intentionally empty — logging failed, not critical
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('readable', () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) input += chunk;
});

process.stdin.on('end', async () => {
  try {
    const rawInput = JSON.parse(input);
    const agent = adapter.detectAgent(rawInput);
    const hookInput = adapter.normalizeInput(agent, 'PreCompact', rawInput);

    // Resolve project dir
    let projectDir = (hookInput.cwd || process.cwd()).replace(/\\/g, '/');

    // Windows path fix: Claude passes /c/... paths; normalize back to C:/...
    if (process.platform === 'win32' && /^\/[a-z]\//.test(projectDir)) {
      projectDir = projectDir[1].toUpperCase() + ':' + projectDir.slice(2);
    }

    const succDir = path.join(projectDir, '.succ');

    if (!fs.existsSync(succDir)) {
      process.exit(0);
      return;
    }

    const sessionId = hookInput.session_id || 'unknown';
    const transcriptPath = hookInput.transcript_path;

    log(
      succDir,
      `PreCompact fired: session=${sessionId}, trigger=${hookInput.trigger || 'unknown'}`
    );

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log(succDir, `No transcript at ${transcriptPath}`);
      process.exit(0);
      return;
    }

    // ── Inline session analysis (fast, no ESM imports) ─────────────

    const content = fs.readFileSync(transcriptPath, 'utf8');
    const totals = {
      text: 0,
      tool_use: 0,
      tool_result: 0,
      thinking: 0,
      image: 0,
      other: 0,
      total: 0,
    };
    const toolCounts = {}; // { name: { calls, inputChars, resultChars } }
    const toolNameById = {}; // { id: name }

    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const msgContent = entry.message && entry.message.content;
      if (!msgContent) continue;

      // String content = text
      if (typeof msgContent === 'string') {
        totals.text += msgContent.length;
        totals.total += msgContent.length;
        continue;
      }

      if (!Array.isArray(msgContent)) continue;

      for (const block of msgContent) {
        if (!block || typeof block !== 'object') continue;
        const btype = block.type || 'other';
        let chars = 0;

        switch (btype) {
          case 'text':
            chars = (block.text || '').length;
            totals.text += chars;
            break;

          case 'tool_use':
            chars = block.input ? JSON.stringify(block.input).length : 0;
            chars += (block.name || '').length + (block.id || '').length;
            totals.tool_use += chars;

            // Track per-tool stats
            if (block.name) {
              if (block.id) toolNameById[block.id] = block.name;
              if (!toolCounts[block.name])
                toolCounts[block.name] = { calls: 0, inputChars: 0, resultChars: 0 };
              toolCounts[block.name].calls++;
              toolCounts[block.name].inputChars += block.input
                ? JSON.stringify(block.input).length
                : 0;
            }
            break;

          case 'tool_result': {
            const rc = block.content;
            if (typeof rc === 'string') chars = rc.length;
            else if (Array.isArray(rc)) chars = JSON.stringify(rc).length;
            totals.tool_result += chars;

            // Track per-tool result chars
            const tuid = block.tool_use_id;
            const toolName = tuid && toolNameById[tuid];
            if (toolName && toolCounts[toolName]) {
              toolCounts[toolName].resultChars += chars;
            }
            break;
          }

          case 'thinking':
            chars = (block.thinking || '').length;
            totals.thinking += chars;
            break;

          case 'image':
            chars = block.source ? JSON.stringify(block.source).length : 100;
            totals.image += chars;
            break;

          default:
            chars = JSON.stringify(block).length;
            totals.other += chars;
            break;
        }

        totals.total += chars;
      }
    }

    // Convert to tokens (chars / 4)
    const tokenTotals = {};
    for (const key of Object.keys(totals)) {
      tokenTotals[key] = Math.ceil(totals[key] / 4);
    }

    // Top tools by total tokens (sorted desc, top 10)
    const topTools = Object.entries(toolCounts)
      .map(([name, stats]) => ({
        name,
        calls: stats.calls,
        tokens: Math.ceil((stats.inputChars + stats.resultChars) / 4),
      }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 10);

    const strippableTokens =
      tokenTotals.tool_use + tokenTotals.tool_result + tokenTotals.thinking + tokenTotals.image;
    const strippablePercent =
      tokenTotals.total > 0 ? ((strippableTokens / tokenTotals.total) * 100).toFixed(1) : '0.0';

    // ── Save stats ────────────────────────────────────────────────

    const stats = {
      sessionId,
      timestamp: new Date().toISOString(),
      trigger: hookInput.trigger || 'unknown',
      tokenTotals,
      topTools,
      strippableTokens,
      strippablePercent: parseFloat(strippablePercent),
    };

    const tmpDir = path.join(succDir, '.tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const statsFile = path.join(tmpDir, `pre-compact-stats-${sessionId}.json`);
    fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2), 'utf8');

    log(
      succDir,
      `Saved pre-compact stats: ${tokenTotals.total} total tokens, ${strippablePercent}% trimmable`
    );
    log(
      succDir,
      `Top tools: ${topTools
        .slice(0, 3)
        .map((t) => `${t.name}:${t.tokens}`)
        .join(', ')}`
    );

    // ── Notify daemon (fire-and-forget) ──────────────────────────

    try {
      const portFile = path.join(tmpDir, 'daemon.port');
      if (fs.existsSync(portFile)) {
        const port = fs.readFileSync(portFile, 'utf8').trim();
        fetch(`http://127.0.0.1:${port}/api/hooks/pre-compact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(stats),
          signal: AbortSignal.timeout(2000),
        }).catch(() => {
          /* fire and forget */
        });
      }
    } catch (e) {
      log(succDir, `Daemon notify failed: ${e.message || e}`);
    }

    // Allow event loop to drain (pending fetch promises) before exiting
    process.exitCode = 0;
  } catch (err) {
    // Fail-open: never block compaction
    try {
      let projectDir = (JSON.parse(input).cwd || process.cwd()).replace(/\\/g, '/');
      if (process.platform === 'win32' && /^\/[a-z]\//.test(projectDir)) {
        projectDir = projectDir[1].toUpperCase() + ':' + projectDir.slice(2);
      }
      log(path.join(projectDir, '.succ'), `PreCompact error: ${err.message || err}`);
    } catch {
      /* last-resort catch — logging itself failed, nothing we can do */
    }
    process.exitCode = 0;
  }
});

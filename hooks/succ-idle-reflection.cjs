#!/usr/bin/env node
/**
 * Idle Reflection Hook - Triggered when Claude has been idle
 *
 * Uses Claude CLI to generate meaningful reflection from session context.
 * Writes to .succ/brain/.self/reflections.md
 *
 * Fires on Notification event with idle_prompt matcher (after ~60 seconds idle)
 */

const { spawn } = require('child_process');
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
    let projectDir = hookInput.cwd || process.cwd();

    // Convert /c/... to C:/... on Windows if needed
    if (process.platform === 'win32' && /^\/[a-z]\//.test(projectDir)) {
      projectDir = projectDir[1].toUpperCase() + ':' + projectDir.slice(2);
    }

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].substring(0, 5);

    // Path to reflections file
    const reflectionsPath = path.join(projectDir, '.succ', 'brain', '.self', 'reflections.md');

    // Create .self directory if needed
    const selfDir = path.dirname(reflectionsPath);
    if (!fs.existsSync(selfDir)) {
      fs.mkdirSync(selfDir, { recursive: true });
    }

    // Read transcript to understand context
    let transcriptContext = '';
    if (hookInput.transcript_path && fs.existsSync(hookInput.transcript_path)) {
      try {
        const transcriptContent = fs.readFileSync(hookInput.transcript_path, 'utf8');
        const lines = transcriptContent.trim().split('\n');
        // Get last 20 entries for context
        const recentLines = lines.slice(-20);
        transcriptContext = recentLines
          .map(line => {
            try {
              const entry = JSON.parse(line);
              // Extract text content - content can be string or array of content blocks
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
        // Couldn't read transcript
      }
    }

    if (!transcriptContext || transcriptContext.length < 100) {
      // Not enough context for meaningful reflection
      process.exit(0);
    }

    // Generate reflection via Claude CLI
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

    const proc = spawn('claude', ['-p', '--tools', '', '--model', 'haiku'], {
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
      }
      process.exit(0);
    });

    proc.on('error', () => {
      process.exit(0);
    });

    // Timeout after 25 seconds (hook timeout is 30)
    setTimeout(() => {
      proc.kill();
      process.exit(0);
    }, 25000);

  } catch (err) {
    process.exit(0);
  }
});

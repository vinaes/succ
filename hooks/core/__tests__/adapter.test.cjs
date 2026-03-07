#!/usr/bin/env node
/**
 * Unit tests for hooks/core/adapter.cjs
 *
 * Run: node hooks/core/__tests__/adapter.test.cjs
 * All assertions use Node.js built-in assert (no npm deps).
 */

'use strict';

const assert = require('assert');
const path = require('path');
const adapter = require(path.join(__dirname, '..', 'adapter.cjs'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

// ─── detectAgent ───

console.log('\ndetectAgent:');

test('defaults to claude when no env or stdin', () => {
  delete process.env.SUCC_AGENT;
  assert.strictEqual(adapter.detectAgent(), 'claude');
  assert.strictEqual(adapter.detectAgent({}), 'claude');
  assert.strictEqual(adapter.detectAgent(null), 'claude');
});

test('respects SUCC_AGENT env var', () => {
  process.env.SUCC_AGENT = 'cursor';
  assert.strictEqual(adapter.detectAgent(), 'cursor');
  process.env.SUCC_AGENT = 'COPILOT';
  assert.strictEqual(adapter.detectAgent(), 'copilot');
  process.env.SUCC_AGENT = 'Gemini';
  assert.strictEqual(adapter.detectAgent(), 'gemini');
  process.env.SUCC_AGENT = 'Claude';
  assert.strictEqual(adapter.detectAgent(), 'claude');
  process.env.SUCC_AGENT = 'unknown-agent';
  assert.strictEqual(adapter.detectAgent(), 'claude');
  delete process.env.SUCC_AGENT;
});

test('detects copilot from stdin heuristic', () => {
  delete process.env.SUCC_AGENT;
  assert.strictEqual(adapter.detectAgent({ toolInput: {}, hookEvent: 'preToolUse' }), 'copilot');
});

test('detects cursor from stdin heuristic (camelCase event)', () => {
  delete process.env.SUCC_AGENT;
  assert.strictEqual(adapter.detectAgent({ event: 'preToolUse' }), 'cursor');
});

test('detects gemini from stdin heuristic (PascalCase event)', () => {
  delete process.env.SUCC_AGENT;
  assert.strictEqual(adapter.detectAgent({ event: 'PreToolUse' }), 'gemini');
});

// ─── mapToolName ───

console.log('\nmapToolName:');

test('claude passes through unchanged', () => {
  assert.strictEqual(adapter.mapToolName('claude', 'Bash'), 'Bash');
  assert.strictEqual(adapter.mapToolName('claude', 'Edit'), 'Edit');
});

test('cursor maps tool names', () => {
  assert.strictEqual(adapter.mapToolName('cursor', 'shell'), 'Bash');
  assert.strictEqual(adapter.mapToolName('cursor', 'edit'), 'Edit');
  assert.strictEqual(adapter.mapToolName('cursor', 'read'), 'Read');
  assert.strictEqual(adapter.mapToolName('cursor', 'write'), 'Write');
  assert.strictEqual(adapter.mapToolName('cursor', 'grep'), 'Grep');
  assert.strictEqual(adapter.mapToolName('cursor', 'glob'), 'Glob');
});

test('copilot maps tool names', () => {
  assert.strictEqual(adapter.mapToolName('copilot', 'bash'), 'Bash');
  assert.strictEqual(adapter.mapToolName('copilot', 'editFile'), 'Edit');
  assert.strictEqual(adapter.mapToolName('copilot', 'view'), 'Read');
});

test('gemini maps tool names', () => {
  assert.strictEqual(adapter.mapToolName('gemini', 'FileEdit'), 'Edit');
  assert.strictEqual(adapter.mapToolName('gemini', 'FileWrite'), 'Write');
  assert.strictEqual(adapter.mapToolName('gemini', 'FileRead'), 'Read');
});

test('unknown tool names pass through', () => {
  assert.strictEqual(adapter.mapToolName('cursor', 'CustomTool'), 'CustomTool');
  assert.strictEqual(adapter.mapToolName('copilot', 'SomeOtherTool'), 'SomeOtherTool');
});

// ─── normalizeInput ───

console.log('\nnormalizeInput:');

test('claude input passes through unchanged', () => {
  const input = { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/tmp' };
  const result = adapter.normalizeInput('claude', input);
  assert.strictEqual(result, input); // same reference
});

test('cursor input normalizes camelCase fields', () => {
  const input = {
    toolName: 'shell',
    toolInput: { command: 'ls' },
    workingDirectory: '/home/user/project',
    userPrompt: 'list files',
    sessionId: 'abc123',
  };
  const result = adapter.normalizeInput('cursor', input);
  assert.strictEqual(result.tool_name, 'Bash');
  assert.deepStrictEqual(result.tool_input, { command: 'ls' });
  assert.strictEqual(result.cwd, '/home/user/project');
  assert.strictEqual(result.prompt, 'list files');
  assert.strictEqual(result.session_id, 'abc123');
});

test('copilot input normalizes fields', () => {
  const input = {
    toolName: 'editFile',
    toolInput: { file_path: '/tmp/test.js' },
    hookEvent: 'preToolUse',
    workingDirectory: '/project',
  };
  const result = adapter.normalizeInput('copilot', input);
  assert.strictEqual(result.tool_name, 'Edit');
  assert.strictEqual(result.hookEventName, 'preToolUse');
  assert.strictEqual(result.cwd, '/project');
});

test('copilot toolArgs double-encoded JSON is decoded', () => {
  const input = {
    toolName: 'bash',
    toolArgs: '{"command":"ls -la"}',
    hookEvent: 'preToolUse',
  };
  const result = adapter.normalizeInput('copilot', input);
  assert.strictEqual(result.tool_name, 'Bash');
  assert.deepStrictEqual(result.tool_input, { command: 'ls -la' });
});

test('copilot toolArgs invalid JSON falls back to string', () => {
  const input = {
    toolName: 'bash',
    toolArgs: 'not-json',
    hookEvent: 'preToolUse',
  };
  const result = adapter.normalizeInput('copilot', input);
  assert.strictEqual(result.tool_input, 'not-json');
});

test('gemini input normalizes fields', () => {
  const input = {
    toolName: 'FileWrite',
    toolInput: { file_path: '/tmp/out.txt', content: 'hello' },
    userPrompt: 'write a file',
    workingDirectory: '/workspace',
  };
  const result = adapter.normalizeInput('gemini', input);
  assert.strictEqual(result.tool_name, 'Write');
  assert.strictEqual(result.prompt, 'write a file');
  assert.strictEqual(result.cwd, '/workspace');
});

// ─── formatOutput ───

console.log('\nformatOutput:');

test('empty result returns empty json, exit 0', () => {
  for (const agent of ['claude', 'cursor', 'copilot', 'gemini']) {
    const { json, exitCode } = adapter.formatOutput(agent, 'PreToolUse', {});
    assert.deepStrictEqual(json, {});
    assert.strictEqual(exitCode, 0);
  }
});

test('null result returns empty json, exit 0', () => {
  const { json, exitCode } = adapter.formatOutput('claude', 'PreToolUse', null);
  assert.deepStrictEqual(json, {});
  assert.strictEqual(exitCode, 0);
});

// Deny tests
test('claude deny format', () => {
  const { json, exitCode } = adapter.formatOutput('claude', 'PreToolUse', {
    deny: true,
    denyReason: 'dangerous command',
  });
  assert.strictEqual(json.hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(json.hookSpecificOutput.permissionDecisionReason, 'dangerous command');
  assert.strictEqual(json.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(exitCode, 0);
});

test('cursor deny format — exit code 2', () => {
  const { json, exitCode } = adapter.formatOutput('cursor', 'PreToolUse', {
    deny: true,
    denyReason: 'blocked',
  });
  assert.strictEqual(json.permission, 'deny');
  assert.strictEqual(json.user_message, 'blocked');
  assert.strictEqual(json.agent_message, 'blocked');
  assert.strictEqual(exitCode, 2);
});

test('copilot deny format — exit code 0', () => {
  const { json, exitCode } = adapter.formatOutput('copilot', 'PreToolUse', {
    deny: true,
    denyReason: 'not allowed',
  });
  assert.strictEqual(json.permissionDecision, 'deny');
  assert.strictEqual(json.permissionDecisionReason, 'not allowed');
  assert.strictEqual(exitCode, 0);
});

test('gemini deny format — exit code 2', () => {
  const { json, exitCode } = adapter.formatOutput('gemini', 'PreToolUse', {
    deny: true,
    denyReason: 'forbidden',
  });
  assert.strictEqual(json.decision, 'deny');
  assert.strictEqual(json.reason, 'forbidden');
  assert.strictEqual(exitCode, 2);
});

// Ask tests
test('claude ask format', () => {
  const { json, exitCode } = adapter.formatOutput('claude', 'PreToolUse', {
    ask: true,
    askReason: 'needs confirmation',
  });
  assert.strictEqual(json.hookSpecificOutput.permissionDecision, 'ask');
  assert.strictEqual(json.hookSpecificOutput.permissionDecisionReason, 'needs confirmation');
  assert.strictEqual(exitCode, 0);
});

test('cursor ask format', () => {
  const { json, exitCode } = adapter.formatOutput('cursor', 'PreToolUse', {
    ask: true,
    askReason: 'confirm?',
  });
  assert.strictEqual(json.permission, 'ask');
  assert.strictEqual(json.user_message, 'confirm?');
  assert.strictEqual(exitCode, 0);
});

// Context injection tests
test('claude additionalContext format', () => {
  const { json, exitCode } = adapter.formatOutput('claude', 'SessionStart', {
    additionalContext: 'hello world',
  });
  assert.strictEqual(json.hookSpecificOutput.additionalContext, 'hello world');
  assert.strictEqual(json.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.strictEqual(exitCode, 0);
});

test('copilot additionalContext uses systemMessage', () => {
  const { json } = adapter.formatOutput('copilot', 'SessionStart', {
    additionalContext: 'context data',
  });
  assert.strictEqual(json.systemMessage, 'context data');
});

test('gemini additionalContext uses systemMessage', () => {
  const { json } = adapter.formatOutput('gemini', 'SessionStart', {
    additionalContext: 'gemini context',
  });
  assert.strictEqual(json.systemMessage, 'gemini context');
});

test('cursor additionalContext format', () => {
  const { json } = adapter.formatOutput('cursor', 'SessionStart', {
    additionalContext: 'cursor context',
  });
  assert.strictEqual(json.additionalContext, 'cursor context');
});

// ─── adaptContext ───

console.log('\nadaptContext:');

test('claude context passes through unchanged', () => {
  const ctx = '<succ-agents>content</succ-agents><other>stuff</other>';
  assert.strictEqual(adapter.adaptContext('claude', ctx), ctx);
});

test('non-claude strips succ-agents section', () => {
  const ctx = 'before\n<succ-agents hint="something">\nagent content\n</succ-agents>\nafter';
  const result = adapter.adaptContext('cursor', ctx);
  assert.ok(!result.includes('succ-agents'));
  assert.ok(!result.includes('agent content'));
  assert.ok(result.includes('before'));
  assert.ok(result.includes('after'));
});

test('non-claude strips pre-commit-review section', () => {
  const ctx = 'before\n<pre-commit-review>\nreview stuff\n</pre-commit-review>\nafter';
  const result = adapter.adaptContext('gemini', ctx);
  assert.ok(!result.includes('pre-commit-review'));
  assert.ok(!result.includes('review stuff'));
  assert.ok(result.includes('before'));
  assert.ok(result.includes('after'));
});

test('non-claude strips subagent references', () => {
  const ctx = 'line1\nuse succ-diff-reviewer for review\nsubagent_type=explore\nline2';
  const result = adapter.adaptContext('copilot', ctx);
  assert.ok(!result.includes('succ-diff-reviewer'));
  assert.ok(!result.includes('subagent_type='));
  assert.ok(result.includes('line1'));
  assert.ok(result.includes('line2'));
});

test('returns empty string for empty input', () => {
  assert.strictEqual(adapter.adaptContext('cursor', ''), '');
  assert.strictEqual(adapter.adaptContext('cursor', null), null);
});

// ─── Summary ───

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

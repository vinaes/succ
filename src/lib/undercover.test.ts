import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  syncClaudeSettings,
  isUndercover,
  ensureGitignore,
  UNDERCOVER_SESSION_BLOCK,
  UNDERCOVER_COMMIT_REMINDER,
} from './undercover.js';

// Temp directory for isolated test runs
let tmpDir: string;
let claudeDir: string;
let succDir: string;
let settingsPath: string;
let statePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercover-test-'));
  claudeDir = path.join(tmpDir, '.claude');
  succDir = path.join(tmpDir, '.succ');
  settingsPath = path.join(claudeDir, 'settings.local.json');
  statePath = path.join(succDir, 'claude-undercover-state.json');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(succDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('syncClaudeSettings', () => {
  it('enable creates snapshot and writes managed fields', () => {
    // Pre-existing settings
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ customKey: 'preserved', includeCoAuthoredBy: true }, null, 2)
    );

    syncClaudeSettings(tmpDir, true);

    // Verify managed fields were written
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.includeGitInstructions).toBe(false);
    expect(settings.includeCoAuthoredBy).toBe(false);
    expect(settings.attribution).toEqual({ commit: '', pr: '' });
    // Unrelated key preserved
    expect(settings.customKey).toBe('preserved');

    // Verify snapshot was created
    expect(fs.existsSync(statePath)).toBe(true);
    const snapshot = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(snapshot.managed.includeCoAuthoredBy).toBe(true);
    expect(snapshot.keysExisted.includeCoAuthoredBy).toBe(true);
    expect(snapshot.keysExisted.includeGitInstructions).toBe(false);
    expect(snapshot.keysExisted.attribution).toBe(false);
  });

  it('disable restores from snapshot and deletes it', () => {
    // Enable first
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ customKey: 'preserved', includeCoAuthoredBy: true }, null, 2)
    );
    syncClaudeSettings(tmpDir, true);

    // Disable
    syncClaudeSettings(tmpDir, false);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // includeCoAuthoredBy should be restored to original value
    expect(settings.includeCoAuthoredBy).toBe(true);
    // Keys that didn't exist before should be removed
    expect('includeGitInstructions' in settings).toBe(false);
    expect('attribution' in settings).toBe(false);
    // Unrelated key preserved
    expect(settings.customKey).toBe('preserved');
    // Snapshot should be deleted
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('detects manual edits during undercover and skips restore', () => {
    syncClaudeSettings(tmpDir, true);

    // User manually changes a managed field
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.includeCoAuthoredBy = true; // changed from false
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    syncClaudeSettings(tmpDir, false);

    // Values should stay as user edited them (no restore)
    const restored = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(restored.includeCoAuthoredBy).toBe(true);
    // Snapshot should still be deleted
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('round-trip: enable -> disable -> enable creates fresh snapshot', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: true }, null, 2));

    // Enable
    syncClaudeSettings(tmpDir, true);
    expect(fs.existsSync(statePath)).toBe(true);

    // Disable
    syncClaudeSettings(tmpDir, false);
    expect(fs.existsSync(statePath)).toBe(false);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.includeCoAuthoredBy).toBe(true);

    // Enable again — should create fresh snapshot
    syncClaudeSettings(tmpDir, true);
    expect(fs.existsSync(statePath)).toBe(true);
    const snap2 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    // New snapshot should reflect restored values
    expect(snap2.managed.includeCoAuthoredBy).toBe(true);
  });

  it('preserves unrelated settings.json keys', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: { PreToolUse: [{ command: 'test' }] },
          permissions: { allow: ['Bash(git:*)'] },
          theme: 'dark',
        },
        null,
        2
      )
    );

    syncClaudeSettings(tmpDir, true);
    const enabled = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(enabled.hooks).toEqual({ PreToolUse: [{ command: 'test' }] });
    expect(enabled.permissions).toEqual({ allow: ['Bash(git:*)'] });
    expect(enabled.theme).toBe('dark');

    syncClaudeSettings(tmpDir, false);
    const disabled = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(disabled.hooks).toEqual({ PreToolUse: [{ command: 'test' }] });
    expect(disabled.permissions).toEqual({ allow: ['Bash(git:*)'] });
    expect(disabled.theme).toBe('dark');
  });

  it('handles settings file deleted between enable and disable', () => {
    syncClaudeSettings(tmpDir, true);
    expect(fs.existsSync(statePath)).toBe(true);

    // Delete settings.local.json while undercover is enabled
    fs.unlinkSync(settingsPath);

    // Disable should gracefully handle missing file
    syncClaudeSettings(tmpDir, false);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('does not overwrite existing snapshot on re-enable', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: true }, null, 2));
    syncClaudeSettings(tmpDir, true);

    const snap1 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const timestamp1 = snap1.createdAt;

    // Call enable again — should NOT overwrite snapshot
    syncClaudeSettings(tmpDir, true);
    const snap2 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(snap2.createdAt).toBe(timestamp1);
    expect(snap2.managed.includeCoAuthoredBy).toBe(true);
  });

  it('creates .claude and .succ dirs if they do not exist', () => {
    // Remove directories
    fs.rmSync(claudeDir, { recursive: true, force: true });
    fs.rmSync(succDir, { recursive: true, force: true });

    syncClaudeSettings(tmpDir, true);

    expect(fs.existsSync(settingsPath)).toBe(true);
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it('handles corrupt settings.local.json gracefully', () => {
    fs.writeFileSync(settingsPath, 'not-json');

    // Should not throw
    syncClaudeSettings(tmpDir, true);

    // Should have overwritten with undercover values
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.includeCoAuthoredBy).toBe(false);
    expect(settings.includeGitInstructions).toBe(false);
  });

  it('handles no snapshot on disable gracefully', () => {
    // No snapshot exists — disable should log warning but not throw
    syncClaudeSettings(tmpDir, false);
    // Should not throw, no crash
  });
});

describe('isUndercover', () => {
  it('returns false by default (no undercover config set)', () => {
    // isUndercover reads from getConfig() — in test env without config it should return false
    expect(isUndercover()).toBe(false);
  });
});

describe('ensureGitignore', () => {
  it('warns when .gitignore is missing', () => {
    // No .gitignore in tmpDir — should not throw
    ensureGitignore(tmpDir);
  });

  it('does not warn when .succ/ and .claude/ are in .gitignore', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.succ/\n.claude/\nnode_modules/\n');
    // Should not throw or warn (we can't easily assert logWarn was called, but no crash)
    ensureGitignore(tmpDir);
  });

  it('handles .gitignore without succ/claude entries', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n*.log\n');
    // Should log warnings about missing entries but not throw
    ensureGitignore(tmpDir);
  });
});

describe('XML blocks', () => {
  it('UNDERCOVER_SESSION_BLOCK contains critical keywords', () => {
    expect(UNDERCOVER_SESSION_BLOCK).toContain('UNDERCOVER MODE');
    expect(UNDERCOVER_SESSION_BLOCK).toContain('priority="critical"');
    expect(UNDERCOVER_SESSION_BLOCK).toContain('Co-Authored-By');
    expect(UNDERCOVER_SESSION_BLOCK).toContain('Branch Naming');
    expect(UNDERCOVER_SESSION_BLOCK).toContain('PR Labels');
    expect(UNDERCOVER_SESSION_BLOCK).toContain('Code Writing Style');
  });

  it('UNDERCOVER_COMMIT_REMINDER is compact', () => {
    expect(UNDERCOVER_COMMIT_REMINDER).toContain('undercover-reminder');
    expect(UNDERCOVER_COMMIT_REMINDER).toContain('No AI attribution');
    // Should be significantly shorter than session block
    expect(UNDERCOVER_COMMIT_REMINDER.length).toBeLessThan(UNDERCOVER_SESSION_BLOCK.length / 2);
  });
});

/**
 * Quality Gate Runner
 *
 * Executes quality gate commands (typecheck, test, lint, build)
 * and returns structured results.
 *
 * NOTE: execSync is used intentionally here — gate commands come from
 * project config (auto-detected from tsconfig.json, package.json, etc.)
 * or explicit user --gates flag, not from untrusted input.
 * Shell features (pipes, &&) may be needed in gate commands.
 */

import { execSync } from 'child_process';
import path from 'path';
import type { QualityGate, GateResult } from './types.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Truncate text keeping the tail (where errors typically appear).
 */
function tailTruncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return '...(truncated)\n' + text.slice(-maxLen);
}

// ============================================================================
// Run a single gate
// ============================================================================

/**
 * Execute a single quality gate command.
 */
export function runGate(gate: QualityGate, cwd: string): GateResult {
  const start = Date.now();

  // Prepend node_modules/.bin to PATH so tools resolve in worktrees
  const binDir = path.join(cwd, 'node_modules', '.bin');
  const envPath = process.env.PATH || process.env.Path || '';
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${envPath}` };

  try {
    const output = execSync(gate.command, {
      cwd,
      timeout: gate.timeout_ms,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env,
      windowsHide: true,
    });
    return {
      gate,
      passed: true,
      output: tailTruncate(output, 5000),
      duration_ms: Date.now() - start,
    };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const output = tailTruncate(
      [err.stdout, err.stderr, err.message].filter(Boolean).join('\n'),
      5000,
    );
    return {
      gate,
      passed: false,
      output,
      duration_ms: Date.now() - start,
    };
  }
}

// ============================================================================
// Run all gates
// ============================================================================

/**
 * Run all quality gates and return results.
 * Continues running all gates even if one fails (to give full picture).
 */
export function runAllGates(gates: QualityGate[], cwd: string): GateResult[] {
  return gates.map(gate => runGate(gate, cwd));
}

/**
 * Check if all required gates passed.
 */
export function allRequiredPassed(results: GateResult[]): boolean {
  return results.every(r => r.passed || !r.gate.required);
}

/**
 * Format gate results for display.
 */
export function formatGateResults(results: GateResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const icon = r.passed ? '[+]' : '[x]';
    const req = r.gate.required ? '' : ' (optional)';
    lines.push(`  ${icon} ${r.gate.type}: ${r.gate.command}${req} (${r.duration_ms}ms)`);
    if (!r.passed && r.output) {
      // Show last 20 lines of failure output (errors are at the end)
      const outputLines = r.output.split('\n').slice(-20);
      for (const line of outputLines) {
        lines.push(`      ${line}`);
      }
    }
  }
  return lines.join('\n');
}

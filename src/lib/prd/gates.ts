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
import type { QualityGate, GateResult } from './types.js';

// ============================================================================
// Run a single gate
// ============================================================================

/**
 * Execute a single quality gate command.
 */
export function runGate(gate: QualityGate, cwd: string): GateResult {
  const start = Date.now();
  try {
    const output = execSync(gate.command, {
      cwd,
      timeout: gate.timeout_ms,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return {
      gate,
      passed: true,
      output: output.slice(0, 5000), // Truncate large outputs
      duration_ms: Date.now() - start,
    };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const output = [err.stdout, err.stderr, err.message]
      .filter(Boolean)
      .join('\n')
      .slice(0, 5000);
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
      // Show first few lines of failure output
      const outputLines = r.output.split('\n').slice(0, 10);
      for (const line of outputLines) {
        lines.push(`      ${line}`);
      }
    }
  }
  return lines.join('\n');
}

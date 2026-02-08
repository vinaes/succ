import { describe, it, expect } from 'vitest';
import { runGate, runAllGates, allRequiredPassed, formatGateResults } from './gates.js';
import { createGate } from './types.js';

describe('Quality Gates', () => {
  describe('runGate', () => {
    it('should pass for a successful command', () => {
      const gate = createGate('custom', 'echo "hello"');
      const result = runGate(gate, process.cwd());
      expect(result.passed).toBe(true);
      expect(result.output).toContain('hello');
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should fail for a failing command', () => {
      const gate = createGate('custom', 'exit 1');
      const result = runGate(gate, process.cwd());
      expect(result.passed).toBe(false);
    });

    it('should fail for a non-existent command', () => {
      const gate = createGate('custom', 'nonexistent_command_12345');
      const result = runGate(gate, process.cwd());
      expect(result.passed).toBe(false);
    });

    it('should respect timeout', () => {
      // Use a command that takes a long time, with a short timeout
      const gate = createGate('custom', 'ping -n 10 127.0.0.1', true, 500);
      const result = runGate(gate, process.cwd());
      expect(result.passed).toBe(false);
      expect(result.duration_ms).toBeLessThan(5000);
    });
  });

  describe('runAllGates', () => {
    it('should run all gates', () => {
      const gates = [
        createGate('custom', 'echo "gate1"'),
        createGate('custom', 'echo "gate2"'),
      ];
      const results = runAllGates(gates, process.cwd());
      expect(results).toHaveLength(2);
      expect(results[0].passed).toBe(true);
      expect(results[1].passed).toBe(true);
    });

    it('should continue running even if one fails', () => {
      const gates = [
        createGate('custom', 'exit 1'),
        createGate('custom', 'echo "still runs"'),
      ];
      const results = runAllGates(gates, process.cwd());
      expect(results).toHaveLength(2);
      expect(results[0].passed).toBe(false);
      expect(results[1].passed).toBe(true);
    });
  });

  describe('allRequiredPassed', () => {
    it('should return true when all required pass', () => {
      const results = [
        { gate: createGate('test', 'npm test'), passed: true, output: '', duration_ms: 100 },
        { gate: createGate('lint', 'eslint', false), passed: false, output: 'warning', duration_ms: 50 },
      ];
      expect(allRequiredPassed(results)).toBe(true);
    });

    it('should return false when a required gate fails', () => {
      const results = [
        { gate: createGate('test', 'npm test'), passed: false, output: 'FAIL', duration_ms: 100 },
      ];
      expect(allRequiredPassed(results)).toBe(false);
    });

    it('should return true for empty results', () => {
      expect(allRequiredPassed([])).toBe(true);
    });
  });

  describe('formatGateResults', () => {
    it('should format passed gates with [+]', () => {
      const results = [
        { gate: createGate('test', 'npm test'), passed: true, output: 'ok', duration_ms: 100 },
      ];
      const formatted = formatGateResults(results);
      expect(formatted).toContain('[+]');
      expect(formatted).toContain('npm test');
    });

    it('should format failed gates with [x] and output', () => {
      const results = [
        { gate: createGate('test', 'npm test'), passed: false, output: 'Error: test failed', duration_ms: 100 },
      ];
      const formatted = formatGateResults(results);
      expect(formatted).toContain('[x]');
      expect(formatted).toContain('Error: test failed');
    });

    it('should mark optional gates', () => {
      const results = [
        { gate: createGate('lint', 'eslint', false), passed: true, output: '', duration_ms: 50 },
      ];
      const formatted = formatGateResults(results);
      expect(formatted).toContain('(optional)');
    });
  });
});

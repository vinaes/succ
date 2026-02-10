import { describe, it, expect } from 'vitest';
import { detectExecutionProvider } from './ort-provider.js';

describe('detectExecutionProvider', () => {
  it('should return dml on win32 when gpu_enabled', () => {
    const result = detectExecutionProvider('win32', { gpu_enabled: true });
    expect(result.provider).toBe('dml');
    expect(result.fallbackChain).toContain('cpu');
  });

  it('should return coreml on darwin arm64 when gpu_enabled', () => {
    const result = detectExecutionProvider('darwin', { gpu_enabled: true, arch: 'arm64' });
    expect(result.provider).toBe('coreml');
  });

  it('should return cpu on darwin x64', () => {
    const result = detectExecutionProvider('darwin', { gpu_enabled: true, arch: 'x64' });
    expect(result.provider).toBe('cpu');
  });

  it('should return cuda on linux when gpu_enabled', () => {
    const result = detectExecutionProvider('linux', { gpu_enabled: true });
    expect(result.provider).toBe('cuda');
    expect(result.fallbackChain).toContain('cpu');
  });

  it('should return cpu when gpu_enabled is false', () => {
    const result = detectExecutionProvider('win32', { gpu_enabled: false });
    expect(result.provider).toBe('cpu');
    expect(result.fallbackChain).toEqual(['cpu']);
  });

  it('should respect explicit gpu_device=cuda override', () => {
    const result = detectExecutionProvider('win32', { gpu_enabled: true, gpu_device: 'cuda' });
    expect(result.provider).toBe('cuda');
  });

  it('should return cpu when gpu_device explicitly set to cpu', () => {
    const result = detectExecutionProvider('win32', { gpu_enabled: true, gpu_device: 'cpu' });
    expect(result.provider).toBe('cpu');
  });

  it('should warn when directml requested on non-Windows', () => {
    const result = detectExecutionProvider('linux', { gpu_enabled: true, gpu_device: 'directml' });
    expect(result.provider).toBe('cpu');
    expect(result.warning).toContain('DirectML');
  });

  it('should always include cpu at end of fallback chain', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const result = detectExecutionProvider(platform, { gpu_enabled: true, arch: 'arm64' });
      expect(result.fallbackChain[result.fallbackChain.length - 1]).toBe('cpu');
    }
  });

  it('should warn when coreml requested on non-macOS', () => {
    const result = detectExecutionProvider('win32', { gpu_enabled: true, gpu_device: 'coreml' });
    expect(result.provider).toBe('cpu');
    expect(result.warning).toContain('CoreML');
  });

  it('should default gpu_enabled to true', () => {
    const result = detectExecutionProvider('win32', {});
    expect(result.provider).toBe('dml');
  });
});

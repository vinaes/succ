/**
 * ONNX Runtime Execution Provider auto-detection.
 *
 * Selects the best provider per platform:
 * - Windows: dml (DirectML, any GPU vendor, bundled)
 * - macOS arm64: coreml (Apple Silicon, bundled)
 * - Linux: cuda (requires user-installed CUDA 12)
 * - All platforms: cpu as fallback (4.6x faster than WASM)
 *
 * Note: onnxruntime-node 1.25+ uses short backend names ('cpu', 'dml', 'cuda', 'coreml')
 * instead of legacy 'CPUExecutionProvider', 'DmlExecutionProvider', etc.
 */

export interface OrtProviderOptions {
  gpu_enabled?: boolean;
  gpu_device?: 'cuda' | 'directml' | 'coreml' | 'webgpu' | 'cpu';
  arch?: string;
}

export interface OrtProviderResult {
  /** Primary provider to try first */
  provider: string;
  /** Full fallback chain including primary, ending with cpu */
  fallbackChain: string[];
  /** Warning message if the requested config can't be honored */
  warning?: string;
}

export function detectExecutionProvider(
  platform: string,
  options: OrtProviderOptions = {}
): OrtProviderResult {
  const gpuEnabled = options.gpu_enabled !== false;
  const arch = options.arch || process.arch;

  // Explicit CPU request or GPU disabled
  if (!gpuEnabled || options.gpu_device === 'cpu') {
    return { provider: 'cpu', fallbackChain: ['cpu'] };
  }

  // Explicit gpu_device override (cpu already handled above)
  if (options.gpu_device && options.gpu_device !== 'webgpu') {
    return resolveExplicitDevice(options.gpu_device, platform);
  }

  // Auto-detect by platform
  switch (platform) {
    case 'win32':
      return {
        provider: 'dml',
        fallbackChain: ['dml', 'cpu'],
      };
    case 'darwin':
      if (arch === 'arm64') {
        return {
          provider: 'coreml',
          fallbackChain: ['coreml', 'cpu'],
        };
      }
      return { provider: 'cpu', fallbackChain: ['cpu'] };
    case 'linux':
      return {
        provider: 'cuda',
        fallbackChain: ['cuda', 'cpu'],
      };
    default:
      return { provider: 'cpu', fallbackChain: ['cpu'] };
  }
}

function resolveExplicitDevice(
  device: string,
  platform: string
): OrtProviderResult {
  switch (device) {
    case 'directml':
      if (platform !== 'win32') {
        return {
          provider: 'cpu',
          fallbackChain: ['cpu'],
          warning: 'DirectML is only available on Windows. Falling back to CPU.',
        };
      }
      return {
        provider: 'dml',
        fallbackChain: ['dml', 'cpu'],
      };
    case 'cuda':
      return {
        provider: 'cuda',
        fallbackChain: ['cuda', 'cpu'],
      };
    case 'coreml':
      if (platform !== 'darwin') {
        return {
          provider: 'cpu',
          fallbackChain: ['cpu'],
          warning: 'CoreML is only available on macOS. Falling back to CPU.',
        };
      }
      return {
        provider: 'coreml',
        fallbackChain: ['coreml', 'cpu'],
      };
    default:
      return { provider: 'cpu', fallbackChain: ['cpu'] };
  }
}

/**
 * LSP Auto-Installer — installs LSP servers on demand via npm or runtime tools.
 *
 * Install location: ~/.succ/lsp-servers/<name>/
 * Strategies: npm (Tier 1), runtime (Tier 2). Binary download (Tier 3) is defined but not yet implemented.
 * Security: npm --ignore-scripts, server name validation.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logInfo, logWarn } from '../lib/fault-logger.js';
import type { LspServerConfig, InstallStrategy } from './servers.js';

// ============================================================================
// Paths
// ============================================================================

/** Base directory for LSP server installations */
export function getServersDir(): string {
  return path.join(os.homedir(), '.succ', 'lsp-servers');
}

/**
 * Validate a server name to prevent path traversal.
 * Allows only alphanumeric characters, hyphens, underscores, and dots.
 * Rejects absolute paths, path separators, and `..` components.
 */
export function validateServerName(serverName: string): void {
  if (!serverName || serverName.length === 0) {
    throw new Error('Server name must not be empty');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(serverName)) {
    throw new Error(
      `Invalid server name "${serverName}": only alphanumeric characters, hyphens, underscores, and dots are allowed`
    );
  }
  // Reject dot-only names and names containing '..' components
  if (serverName === '.' || serverName === '..' || serverName.includes('..')) {
    throw new Error(`Invalid server name "${serverName}": path traversal not allowed`);
  }
}

/** Get install path for a specific server */
export function getServerPath(serverName: string): string {
  validateServerName(serverName);
  const resolved = path.resolve(getServersDir(), serverName);
  // Guard: ensure the resolved path stays inside the managed directory
  if (
    !resolved.startsWith(path.resolve(getServersDir()) + path.sep) &&
    resolved !== path.resolve(getServersDir())
  ) {
    throw new Error(`Server path "${resolved}" escapes the managed directory`);
  }
  return resolved;
}

/** Get the binary path for a server after installation */
export function getServerBinaryPath(serverName: string, command: string): string {
  // Validate command to prevent path traversal
  const basename = path.basename(command);
  if (basename !== command || command.includes('..')) {
    return command; // Fall back to global command for suspicious input
  }
  const serverDir = getServerPath(serverName);
  const npmBin = path.join(serverDir, 'node_modules', '.bin', command);
  if (fs.existsSync(npmBin)) return npmBin;
  if (fs.existsSync(npmBin + '.cmd')) return npmBin + '.cmd';

  // Try direct path (for binary downloads or runtime installs)
  const direct = path.join(serverDir, command);
  if (fs.existsSync(direct)) return direct;

  // Fall back to global command
  return command;
}

// ============================================================================
// Installation
// ============================================================================

/**
 * Check if a server is already installed.
 */
export function isServerInstalled(serverName: string, command: string): boolean {
  const binaryPath = getServerBinaryPath(serverName, command);

  // Check if it's in our managed directory (append sep to avoid matching siblings)
  const serversDir = getServersDir() + path.sep;
  if (binaryPath.startsWith(serversDir)) {
    return fs.existsSync(binaryPath);
  }

  // Check if it's available globally
  try {
    execFileSync(command, ['--version'], {
      stdio: 'pipe',
      timeout: 5000,
    });
    return true;
  } catch (error) {
    logWarn('lsp-installer', `Server ${command} not found globally`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Install an LSP server.
 *
 * @returns true if installation succeeded
 */
export async function installServer(serverName: string, config: LspServerConfig): Promise<boolean> {
  const serverDir = getServerPath(serverName);

  try {
    switch (config.install.type) {
      case 'npm':
        return installViaNpm(serverName, serverDir, config.install);
      case 'runtime':
        return installViaRuntime(serverName, config.install);
      case 'binary':
        logWarn('lsp-installer', `Binary download not yet implemented for ${serverName}`);
        return false;
      default:
        return false;
    }
  } catch (error) {
    logWarn('lsp-installer', `Failed to install ${serverName}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Install via npm (Tier 1 strategy).
 */
function installViaNpm(
  serverName: string,
  serverDir: string,
  strategy: Extract<InstallStrategy, { type: 'npm' }>
): boolean {
  // Create isolated directory
  fs.mkdirSync(serverDir, { recursive: true });

  // Initialize package.json
  const pkgJson = path.join(serverDir, 'package.json');
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, JSON.stringify({ name: `succ-lsp-${serverName}`, private: true }));
  }

  // Install packages with --ignore-scripts for security
  logInfo('lsp-installer', `Installing ${serverName} via npm: ${strategy.packages.join(', ')}`);

  try {
    execFileSync('npm', ['install', '--ignore-scripts', ...strategy.packages], {
      cwd: serverDir,
      stdio: 'pipe',
      timeout: 120000,
    });
  } catch (error) {
    // Clean up partial install so listInstalledServers() doesn't report false positives
    try {
      fs.rmSync(serverDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      logWarn('lsp-installer', `Failed to clean up partial install for ${serverName}`, {
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
    throw error;
  }

  logInfo('lsp-installer', `Successfully installed ${serverName}`);
  return true;
}

/**
 * Install via runtime (Tier 2 strategy).
 */
function installViaRuntime(
  serverName: string,
  strategy: Extract<InstallStrategy, { type: 'runtime' }>
): boolean {
  // Check if runtime is available
  const checkParts = strategy.check.split(/\s+/);
  try {
    execFileSync(checkParts[0], checkParts.slice(1), { stdio: 'pipe', timeout: 5000 });
  } catch (error) {
    logWarn('lsp-installer', `Cannot install ${serverName}: ${strategy.hint}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  // Run the install command (split into command + args to avoid shell)
  const cmdParts = strategy.installCmd.split(/\s+/);
  logInfo('lsp-installer', `Installing ${serverName}: ${strategy.installCmd}`);
  execFileSync(cmdParts[0], cmdParts.slice(1), {
    stdio: 'pipe',
    timeout: 300000,
  });

  // Record runtime install in manifest so listInstalledServers() can find it
  recordRuntimeInstall(serverName, strategy);

  logInfo('lsp-installer', `Successfully installed ${serverName}`);
  return true;
}

/**
 * Record a runtime install in a manifest file under the server directory.
 * This makes runtime installs visible to listInstalledServers() and
 * allows uninstallServer() to know the install type.
 */
function recordRuntimeInstall(
  serverName: string,
  strategy: Extract<InstallStrategy, { type: 'runtime' }>
): void {
  const serverDir = getServerPath(serverName);
  fs.mkdirSync(serverDir, { recursive: true });
  const manifest = {
    type: 'runtime',
    installedAt: new Date().toISOString(),
    check: strategy.check,
    installCmd: strategy.installCmd,
  };
  fs.writeFileSync(path.join(serverDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

/**
 * Uninstall a server.
 */
export function uninstallServer(serverName: string): boolean {
  const serverDir = getServerPath(serverName);
  if (!fs.existsSync(serverDir)) return true;

  try {
    fs.rmSync(serverDir, { recursive: true, force: true });
    logInfo('lsp-installer', `Uninstalled ${serverName}`);
    return true;
  } catch (error) {
    logWarn('lsp-installer', `Failed to uninstall ${serverName}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * List installed servers.
 */
export function listInstalledServers(): string[] {
  const dir = getServersDir();
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir).filter((entry) => {
    const full = path.join(dir, entry);
    return fs.statSync(full).isDirectory();
  });
}

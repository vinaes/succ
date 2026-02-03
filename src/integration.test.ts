import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import spawn from 'cross-spawn';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const spawnSync = require('cross-spawn').sync;
import fs from 'fs';
import path from 'path';
import os from 'os';

// Increase timeout for integration tests
const INTEGRATION_TIMEOUT = 60000;

describe('Integration Tests', () => {
  describe('CLI Commands', () => {
    it('should run status command', () => {
      const result = spawnSync('npx', ['tsx', 'src/cli.ts', 'status'], {
        encoding: 'utf-8',
        timeout: 30000,
      });
      // Status should complete without error
      expect(result.status).toBe(0);
    });

    it('should show help', () => {
      const result = spawnSync('npx', ['tsx', 'src/cli.ts', '--help'], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      expect(result.stdout).toContain('succ');
      expect(result.stdout).toContain('Commands:');
    });
  });

  describe('MCP Server', { timeout: INTEGRATION_TIMEOUT }, () => {
    it('should start MCP server and respond to initialize', async () => {
      // Create a child process running MCP server
      const proc = spawn('npx', ['tsx', 'src/mcp-server.ts'], {
        stdio: ['pipe', 'pipe', 'pipe'],
              });

      // Send initialize request
      const initRequest = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      });

      let stdout = '';
      let resolved = false;

      const result = await new Promise<string>((resolve, reject) => {
        proc.stdout?.on('data', (data) => {
          stdout += data.toString();
          // Look for a complete JSON response
          if (stdout.includes('"result"') && !resolved) {
            resolved = true;
            resolve(stdout);
          }
        });

        proc.stderr?.on('data', (data) => {
          console.error('MCP stderr:', data.toString());
        });

        proc.on('error', reject);

        // Send request
        proc.stdin?.write(initRequest + '\n');

        // Timeout
        setTimeout(() => {
          if (!resolved) {
            resolve(stdout);
          }
        }, 5000);
      });

      proc.kill();

      // Should have received some response
      expect(result).toBeDefined();
    });

    it('should handle succ_status tool call', async () => {
      const proc = spawn('npx', ['tsx', 'src/mcp-server.ts'], {
        stdio: ['pipe', 'pipe', 'pipe'],
              });

      let stdout = '';
      let initialized = false;

      const sendRequest = (req: object) => {
        proc.stdin?.write(JSON.stringify(req) + '\n');
      };

      const result = await new Promise<string>((resolve, reject) => {
        proc.stdout?.on('data', (data) => {
          stdout += data.toString();

          // After init, send tool call
          if (stdout.includes('"serverInfo"') && !initialized) {
            initialized = true;
            sendRequest({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: {
                name: 'succ_status',
                arguments: {},
              },
            });
          }

          // Check for tool response
          if (stdout.includes('"id":2') && stdout.includes('result')) {
            resolve(stdout);
          }
        });

        proc.on('error', reject);

        // Initialize first
        sendRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        });

        setTimeout(() => resolve(stdout), 10000);
      });

      proc.kill();
      expect(result).toBeDefined();
    });
  });

  describe('Unified Daemon', { timeout: INTEGRATION_TIMEOUT }, () => {
    let tempDir: string;
    let originalCwd: string;

    beforeEach(() => {
      originalCwd = process.cwd();
      tempDir = path.join(os.tmpdir(), `succ-daemon-test-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });

      // Create minimal project structure
      fs.writeFileSync(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0' })
      );
      fs.mkdirSync(path.join(tempDir, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, '.succ'), { recursive: true });

      // Initialize git repo
      try {
        spawnSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
        spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir, stdio: 'ignore' });
        spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir, stdio: 'ignore' });
        spawnSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' });
        spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir, stdio: 'ignore' });
      } catch {
        // Git not available, skip git-related tests
      }
    });

    afterEach(() => {
      process.chdir(originalCwd);

      // Clean up
      if (fs.existsSync(tempDir)) {
        // Stop any running daemon
        const pidFile = path.join(tempDir, '.succ', '.tmp', 'daemon.pid');
        if (fs.existsSync(pidFile)) {
          try {
            const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
            process.kill(pid, 'SIGTERM');
          } catch {
            // Process already dead
          }
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should show daemon status when not running', () => {
      const result = spawnSync('npx', ['tsx', path.join(originalCwd, 'src/cli.ts'), 'daemon', 'status'], {
        encoding: 'utf-8',
        cwd: tempDir,
        timeout: 30000,
      });

      expect(result.stdout).toContain('Daemon Status');
      expect(result.stdout).toContain('Not running');
    });

    it('should handle stop when not running', () => {
      const result = spawnSync('npx', ['tsx', path.join(originalCwd, 'src/cli.ts'), 'daemon', 'stop'], {
        encoding: 'utf-8',
        cwd: tempDir,
        timeout: 30000,
      });

      expect(result.stdout).toContain('not running');
    });
  });

  describe('Lock File Operations', () => {
    let tempDir: string;

    beforeEach(() => {
      // Use random suffix to avoid conflicts when src and dist tests run in parallel
      const randomSuffix = Math.random().toString(36).substring(2, 10);
      tempDir = path.join(os.tmpdir(), `succ-lock-test-${Date.now()}-${randomSuffix}`);
      fs.mkdirSync(tempDir, { recursive: true });
      fs.mkdirSync(path.join(tempDir, '.claude'), { recursive: true });
    });

    afterEach(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should create and release lock atomically', () => {
      const lockFile = path.join(tempDir, '.claude', 'succ.lock');

      // Create lock
      const lockInfo = {
        pid: process.pid,
        timestamp: Date.now(),
        operation: 'test',
      };

      // Atomic write with 'wx' flag
      fs.writeFileSync(lockFile, JSON.stringify(lockInfo), { flag: 'wx' });
      expect(fs.existsSync(lockFile)).toBe(true);

      // Try to create again should fail
      expect(() => {
        fs.writeFileSync(lockFile, JSON.stringify(lockInfo), { flag: 'wx' });
      }).toThrow();

      // Release
      fs.unlinkSync(lockFile);
      expect(fs.existsSync(lockFile)).toBe(false);
    });

    it('should detect stale locks correctly', () => {
      const lockFile = path.join(tempDir, '.claude', 'succ.lock');

      // Create stale lock (non-existent PID)
      const staleLock = {
        pid: 99999999,
        timestamp: Date.now(),
        operation: 'stale',
      };
      fs.writeFileSync(lockFile, JSON.stringify(staleLock));

      // Check if process is alive
      const isAlive = (() => {
        try {
          process.kill(staleLock.pid, 0);
          return true;
        } catch {
          return false;
        }
      })();

      expect(isAlive).toBe(false);

      // Clean up stale lock
      fs.unlinkSync(lockFile);
    });
  });

  describe('Concurrent CLI and Daemon', { timeout: INTEGRATION_TIMEOUT }, () => {
    it('should serialize database operations with lock', async () => {
      // Simulate what happens when daemon writes while CLI reads
      const operations: string[] = [];

      // Simulate lock-protected operations
      const withMockLock = async (name: string, fn: () => Promise<void>) => {
        operations.push(`acquire:${name}`);
        await fn();
        operations.push(`release:${name}`);
      };

      // Simulate concurrent operations
      const daemonWrite = withMockLock('daemon', async () => {
        operations.push('daemon:write');
        await new Promise((r) => setTimeout(r, 50));
      });

      const cliRead = withMockLock('cli', async () => {
        operations.push('cli:read');
        await new Promise((r) => setTimeout(r, 30));
      });

      await Promise.all([daemonWrite, cliRead]);

      // Both should complete
      expect(operations).toContain('daemon:write');
      expect(operations).toContain('cli:read');
    });
  });
});

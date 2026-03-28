/**
 * MCP Resource handlers
 *
 * Provides read-only access to brain vault and soul documents:
 * - brain-list: List all files in brain vault
 * - brain-file: Read a specific brain vault file
 * - brain-index: Get project MOC / CLAUDE.md / Memories.md
 * - soul: Get soul document (AI persona/personality)
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import path from 'path';
import fsp from 'fs/promises';
import { getProjectRoot, getSuccDir } from '../lib/config.js';
import { logWarn } from '../lib/fault-logger.js';
import { getErrorMessage } from '../lib/errors.js';
import { getBrainPath } from './helpers.js';

/**
 * Async recursive directory walk — replaces sync walkDir.
 * Returns relative paths of .md files under `dir`.
 */
async function walkDir(dir: string, prefix: string = ''): Promise<string[]> {
  const files: string[] = [];
  let entries: import('fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    logWarn('resources', `Cannot read directory ${dir}: ${getErrorMessage(err)}`);
    return files;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const subFiles = await walkDir(fullPath, relativePath);
      files.push(...subFiles);
    } else if (entry.name.endsWith('.md')) {
      files.push(relativePath);
    }
  }
  return files;
}

/**
 * Try to read a file, returning its content or null if not found.
 * Only logs on unexpected errors (not ENOENT).
 */
async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logWarn('resources', `Unexpected error reading ${filePath}: ${getErrorMessage(err)}`);
    }
    return null;
  }
}

export function registerResources(server: McpServer) {
  // Resource: List brain vault files
  server.resource(
    'brain-list',
    'brain://list',
    { description: 'List all files in the brain vault' },
    async () => {
      const brainPath = getBrainPath();
      try {
        await fsp.access(brainPath);
      } catch {
        logWarn('resources', 'Brain vault directory not found');
        return {
          contents: [{ uri: 'brain://list', text: 'Brain vault not initialized. Run: succ init' }],
        };
      }

      const files = await walkDir(brainPath);

      const text =
        files.length > 0
          ? `# Brain Vault Files\n\n${files.map((f) => `- ${f}`).join('\n')}`
          : 'Brain vault is empty.';

      return { contents: [{ uri: 'brain://list', mimeType: 'text/markdown', text }] };
    }
  );

  // Resource: Read brain vault file (templated)
  server.resource(
    'brain-file',
    new ResourceTemplate('brain://file/{path}', { list: undefined }),
    { description: 'Read a file from the brain vault. Use brain://list to see available files.' },
    async (uri, variables) => {
      const brainPath = getBrainPath();
      const filePath = variables.path as string | undefined;
      if (!filePath) {
        return { contents: [{ uri: uri.href, text: 'Error: Missing required path parameter' }] };
      }
      const fullPath = path.join(brainPath, filePath);

      // Security: use path.resolve for proper path traversal protection
      const resolvedPath = path.resolve(fullPath);
      const resolvedBrain = path.resolve(brainPath);

      // Check path is within brain vault (handle both exact match and subdirectory)
      if (resolvedPath !== resolvedBrain && !resolvedPath.startsWith(resolvedBrain + path.sep)) {
        return { contents: [{ uri: uri.href, text: 'Error: Path traversal not allowed' }] };
      }

      try {
        // Resolve all symlinks in the entire path hierarchy to prevent traversal via symlinked parents
        const realBrain = await fsp.realpath(brainPath);
        const realPath = await fsp.realpath(fullPath);
        if (realPath !== realBrain && !realPath.startsWith(realBrain + path.sep)) {
          return { contents: [{ uri: uri.href, text: 'Error: Path traversal not allowed' }] };
        }

        // Keep explicit no-symlink policy for the leaf node
        const stats = await fsp.lstat(fullPath);
        if (stats.isSymbolicLink()) {
          return { contents: [{ uri: uri.href, text: 'Error: Symbolic links not allowed' }] };
        }

        const content = await fsp.readFile(realPath, 'utf-8');
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: content }] };
      } catch (err) {
        logWarn('resources', `Failed to read brain file ${filePath}: ${getErrorMessage(err)}`);
        return { contents: [{ uri: uri.href, text: `File not found: ${filePath}` }] };
      }
    }
  );

  // Resource: Brain vault index (summary)
  server.resource(
    'brain-index',
    'brain://index',
    { description: 'Get the brain vault index or CLAUDE.md' },
    async () => {
      const brainPath = getBrainPath();
      try {
        await fsp.access(brainPath);
      } catch {
        logWarn('resources', 'Brain vault directory not found for index');
        return { contents: [{ uri: 'brain://index', text: 'Brain vault not initialized.' }] };
      }

      // Try project MOC first, then CLAUDE.md, then Memories.md
      const projectName = path.basename(getProjectRoot());
      const projectMocPath = path.join(brainPath, 'project', `${projectName}.md`);
      const claudePath = path.join(brainPath, 'CLAUDE.md');
      const memoriesPath = path.join(brainPath, 'Memories.md');

      const candidates = [projectMocPath, claudePath, memoriesPath];
      for (const candidate of candidates) {
        const content = await tryReadFile(candidate);
        if (content !== null) {
          return { contents: [{ uri: 'brain://index', mimeType: 'text/markdown', text: content }] };
        }
      }

      return {
        contents: [
          { uri: 'brain://index', text: 'No project MOC, CLAUDE.md, or Memories.md found.' },
        ],
      };
    }
  );

  // Resource: Soul document (AI persona/personality)
  server.resource(
    'soul',
    'soul://persona',
    {
      description:
        'Get the soul document - defines AI personality, values, and communication style. Read this to understand how to interact with the user.',
    },
    async () => {
      const succDir = getSuccDir();

      // Check multiple possible locations for soul document
      const projectRoot = getProjectRoot();
      const soulPaths = [
        path.join(succDir, 'soul.md'),
        path.join(succDir, 'SOUL.md'),
        path.join(projectRoot, 'soul.md'),
        path.join(projectRoot, 'SOUL.md'),
        path.join(projectRoot, '.soul.md'),
      ];

      for (const soulPath of soulPaths) {
        const content = await tryReadFile(soulPath);
        if (content !== null) {
          return {
            contents: [
              {
                uri: 'soul://persona',
                mimeType: 'text/markdown',
                text: content,
              },
            ],
          };
        }
      }

      return {
        contents: [
          {
            uri: 'soul://persona',
            text: 'No soul document found. Create .succ/soul.md to define AI personality.\n\nRun `succ init` to generate a template.',
          },
        ],
      };
    }
  );
}

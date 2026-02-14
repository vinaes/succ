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
import fs from 'fs';
import { getProjectRoot, getSuccDir } from '../lib/config.js';
import { getBrainPath } from './helpers.js';

export function registerResources(server: McpServer) {
  // Resource: List brain vault files
  server.resource(
    'brain-list',
    'brain://list',
    { description: 'List all files in the brain vault' },
    async () => {
      const brainPath = getBrainPath();
      if (!fs.existsSync(brainPath)) {
        return {
          contents: [{ uri: 'brain://list', text: 'Brain vault not initialized. Run: succ init' }],
        };
      }

      const files: string[] = [];
      function walkDir(dir: string, prefix: string = '') {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const fullPath = path.join(dir, entry.name);
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walkDir(fullPath, relativePath);
          } else if (entry.name.endsWith('.md')) {
            files.push(relativePath);
          }
        }
      }
      walkDir(brainPath);

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
      const filePath = variables.path as string;
      const fullPath = path.join(brainPath, filePath);

      // Security: use path.resolve for proper path traversal protection
      const resolvedPath = path.resolve(fullPath);
      const resolvedBrain = path.resolve(brainPath);

      // Check path is within brain vault (handle both exact match and subdirectory)
      if (resolvedPath !== resolvedBrain && !resolvedPath.startsWith(resolvedBrain + path.sep)) {
        return { contents: [{ uri: uri.href, text: 'Error: Path traversal not allowed' }] };
      }

      if (!fs.existsSync(fullPath)) {
        return { contents: [{ uri: uri.href, text: `File not found: ${filePath}` }] };
      }

      // Check for symlinks (optional security hardening)
      const stats = fs.lstatSync(fullPath);
      if (stats.isSymbolicLink()) {
        return { contents: [{ uri: uri.href, text: 'Error: Symbolic links not allowed' }] };
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: content }] };
    }
  );

  // Resource: Brain vault index (summary)
  server.resource(
    'brain-index',
    'brain://index',
    { description: 'Get the brain vault index or CLAUDE.md' },
    async () => {
      const brainPath = getBrainPath();
      if (!fs.existsSync(brainPath)) {
        return { contents: [{ uri: 'brain://index', text: 'Brain vault not initialized.' }] };
      }

      // Try project MOC first, then CLAUDE.md, then Memories.md
      const projectName = path.basename(getProjectRoot());
      const projectMocPath = path.join(brainPath, '01_Projects', projectName, `${projectName}.md`);
      const claudePath = path.join(brainPath, 'CLAUDE.md');
      const memoriesPath = path.join(brainPath, 'Memories.md');

      if (fs.existsSync(projectMocPath)) {
        const content = fs.readFileSync(projectMocPath, 'utf-8');
        return { contents: [{ uri: 'brain://index', mimeType: 'text/markdown', text: content }] };
      }

      if (fs.existsSync(claudePath)) {
        const content = fs.readFileSync(claudePath, 'utf-8');
        return { contents: [{ uri: 'brain://index', mimeType: 'text/markdown', text: content }] };
      }

      if (fs.existsSync(memoriesPath)) {
        const content = fs.readFileSync(memoriesPath, 'utf-8');
        return { contents: [{ uri: 'brain://index', mimeType: 'text/markdown', text: content }] };
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
        if (fs.existsSync(soulPath)) {
          const content = fs.readFileSync(soulPath, 'utf-8');
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

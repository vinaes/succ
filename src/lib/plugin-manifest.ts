/**
 * Plugin manifest generator.
 *
 * Generates `.claude-plugin/plugin.json` from `package.json` at build time.
 * Keeps version in sync — never edit plugin.json manually.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolve project root (2 levels up from src/lib/) */
function getPackageRoot(): string {
  // In compiled form: dist/lib/plugin-manifest.js → 2 levels up
  // In source form: src/lib/plugin-manifest.ts → 2 levels up
  let dir = __dirname;
  for (let i = 0; i < 2; i++) dir = path.dirname(dir);
  return dir;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: { name: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
}

export function generatePluginManifest(packageRoot?: string): PluginManifest {
  const root = packageRoot ?? getPackageRoot();
  const pkgPath = path.join(root, 'package.json');
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Failed to read package.json at ${pkgPath}: ${err instanceof Error ? err.message : err}`,
    );
  }

  return {
    name: 'succ',
    version: pkg.version as string,
    description:
      (pkg.description as string) ??
      'Persistent memory, semantic search, knowledge graph for AI coding assistants',
    author: {
      name: 'vinaes',
      url: 'https://github.com/vinaes',
    },
    homepage: 'https://succ.ai',
    repository: 'https://github.com/vinaes/succ',
    license: (pkg.license as string) ?? 'FSL-1.1-Apache-2.0',
    keywords:
      (pkg.keywords as string[]) ??
      ['memory', 'rag', 'semantic-search', 'mcp', 'knowledge-graph'],
  };
}

export function writePluginManifest(packageRoot?: string): void {
  const root = packageRoot ?? getPackageRoot();
  const manifest = generatePluginManifest(root);
  const dir = path.join(root, '.claude-plugin');

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');

  // eslint-disable-next-line no-console
  console.log(`Generated .claude-plugin/plugin.json (v${manifest.version})`);
}

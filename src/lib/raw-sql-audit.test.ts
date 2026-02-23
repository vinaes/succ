import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.join(process.cwd(), 'src');
const ALLOWED_RAW_SQL_FILES = new Set(['src/commands/benchmark-sqlite-vec.ts']);

const PREPARE_SQL_RE =
  /\.prepare\(\s*(?:`[\s\S]*?\b(?:SELECT|INSERT|UPDATE|DELETE|PRAGMA|CREATE|ALTER)\b|['"][^'"`]*\b(?:SELECT|INSERT|UPDATE|DELETE|PRAGMA|CREATE|ALTER)\b)/m;
const DB_CONNECTION_IMPORT_RE = /from\s+['"][^'"]*db\/connection\.js['"]/;
const SQLITE_IMPORT_RE = /from\s+['"]better-sqlite3['"]/;
const GET_DB_CALL_RE = /\bget(?:Global)?Db\s*\(/;

function collectSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    out.push(fullPath);
  }

  return out;
}

function toRel(filePath: string): string {
  return path.relative(process.cwd(), filePath).split(path.sep).join('/');
}

function shouldAudit(relPath: string): boolean {
  if (!relPath.startsWith('src/')) return false;
  if (relPath.startsWith('src/lib/db/')) return false;
  if (relPath.startsWith('src/lib/storage/')) return false;
  return true;
}

describe('raw SQL audit outside storage abstraction', () => {
  it('prevents direct SQLite/raw SQL usage outside db/storage layers', () => {
    const violations: string[] = [];
    const files = collectSourceFiles(SOURCE_ROOT);

    for (const filePath of files) {
      const relPath = toRel(filePath);
      if (!shouldAudit(relPath)) continue;
      if (ALLOWED_RAW_SQL_FILES.has(relPath)) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const reasons: string[] = [];

      if (SQLITE_IMPORT_RE.test(content)) reasons.push('imports better-sqlite3');
      if (DB_CONNECTION_IMPORT_RE.test(content)) reasons.push('imports db/connection.js directly');
      if (GET_DB_CALL_RE.test(content)) reasons.push('calls getDb/getGlobalDb directly');
      if (PREPARE_SQL_RE.test(content)) reasons.push('executes SQL via .prepare(...)');

      if (reasons.length > 0) {
        violations.push(`${relPath}: ${reasons.join(', ')}`);
      }
    }

    expect(
      violations,
      `Raw SQL bypass found outside src/lib/db and src/lib/storage:\n${violations.join('\n')}`
    ).toEqual([]);
  });
});

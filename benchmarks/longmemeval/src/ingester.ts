/**
 * Memory ingester — feed LongMemEval conversations into succ memory system
 *
 * Two modes:
 * - 'direct': Save conversation turns as-is (fast, no LLM cost)
 * - 'extract': Use LLM to extract structured facts (realistic, uses LLM)
 */

import Database from 'better-sqlite3';
import { setDb, closeDb, applySqliteTuning } from '../../../src/lib/db/connection.js';
import { initDb, loadSqliteVec } from '../../../src/lib/db/schema.js';
import { saveMemory } from '../../../src/lib/db/memories.js';
import { getEmbedding, getEmbeddings } from '../../../src/lib/embeddings.js';
import { extractFactsWithLLM } from '../../../src/lib/session-summary.js';
import type { LongMemEvalQuestion, ConversationTurn, RunOptions } from './types.js';

/**
 * Create an isolated in-memory SQLite DB for one benchmark question
 */
export function createIsolatedDb(): Database.Database {
  const db = new Database(':memory:');
  applySqliteTuning(db);
  loadSqliteVec(db);
  initDb(db);
  return db;
}

/**
 * Format a conversation session into a text block for memory ingestion
 */
function formatSession(turns: ConversationTurn[], sessionDate: string): string {
  const lines: string[] = [];
  if (sessionDate) {
    lines.push(`[Session date: ${sessionDate}]`);
  }
  for (const turn of turns) {
    const prefix = turn.role === 'user' ? 'User' : 'Assistant';
    lines.push(`${prefix}: ${turn.content}`);
  }
  return lines.join('\n');
}

/**
 * Ingest all conversation sessions for a question into succ memory.
 * Returns the DB instance (caller must close it after use).
 */
export async function ingestQuestion(
  question: LongMemEvalQuestion,
  options: Pick<RunOptions, 'mode' | 'model'>,
): Promise<{ db: Database.Database; memoriesCount: number }> {
  const db = createIsolatedDb();
  setDb(db);

  let memoriesCount = 0;

  for (let i = 0; i < question.haystack_sessions.length; i++) {
    const session = question.haystack_sessions[i];
    const sessionDate = question.haystack_dates[i] || '';

    if (options.mode === 'direct') {
      // Direct mode: save each conversation turn as a separate memory
      // Preserves session date context but avoids giant single-memory entries
      for (const turn of session) {
        const content = sessionDate
          ? `[${sessionDate}] ${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`
          : `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`;
        if (content.length < 20) continue;

        const embedding = await getEmbedding(content);
        saveMemory(content, embedding, ['benchmark'], 'longmemeval', {
          deduplicate: false,
          autoLink: false,
          type: 'observation',
        });
        memoriesCount++;
      }
    } else {
      // Extract mode: use LLM to extract structured facts
      const text = formatSession(session, sessionDate);
      if (text.length < 50) continue;

      const backend = options.model === 'sonnet' ? 'claude' : 'openrouter';
      const model = options.model === 'sonnet' ? 'sonnet' : 'openai/gpt-4o';

      const facts = await extractFactsWithLLM(text, { mode: backend as any, model });

      if (facts.length === 0) {
        // Fallback: save raw text if LLM extraction yields nothing
        const embedding = await getEmbedding(text);
        saveMemory(text, embedding, ['benchmark'], 'longmemeval', {
          deduplicate: false,
          autoLink: false,
          type: 'observation',
        });
        memoriesCount++;
        continue;
      }

      // Batch embed all extracted facts
      const embeddings = await getEmbeddings(facts.map(f => f.content));

      for (let j = 0; j < facts.length; j++) {
        const fact = facts[j];
        saveMemory(fact.content, embeddings[j], fact.tags || ['benchmark'], 'longmemeval', {
          deduplicate: false,
          autoLink: false,
          type: (fact.type as any) || 'observation',
        });
        memoriesCount++;
      }
    }
  }

  return { db, memoriesCount };
}

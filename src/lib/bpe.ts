/**
 * BPE (Byte Pair Encoding) for code tokenization
 *
 * Learns subword vocabulary from code corpus.
 * Used as optional enhancement to Ronin-style segmentation.
 *
 * Training:
 * - Collects all tokens from indexed code
 * - Iteratively merges most frequent pairs
 * - Stores vocabulary in SQLite
 *
 * Schedule:
 * - Retrain hourly if new code indexed
 * - Otherwise daily maintenance
 */

import { getTopTokens, getTokenFrequencyStats, isPostgresBackend } from './storage/index.js';
import {
  initBPESchema as initBPESchemaDb,
  saveBPEVocabToDb,
  loadBPEVocabFromDb,
  getLastBPETrainTimeFromDb,
} from './db/bpe.js';
import { logInfo } from './fault-logger.js';

// ============================================================================
// Types
// ============================================================================

export interface BPEVocab {
  merges: [string, string][]; // Ordered list of merge operations
  vocab: Map<string, number>; // Token -> ID mapping
  vocabSize: number;
  trainedAt: string;
  corpusSize: number; // Number of tokens used for training
}

export interface BPEConfig {
  enabled: boolean;
  vocabSize: number; // Target vocabulary size (default: 5000)
  minFrequency: number; // Min pair frequency to merge (default: 2)
  retrainInterval: 'hourly' | 'daily'; // When to retrain
}

// ============================================================================
// Database Schema
// ============================================================================

export function initBPESchema(): void {
  if (isPostgresBackend()) return; // BPE tables only exist in SQLite
  initBPESchemaDb();
}

// ============================================================================
// BPE Training
// ============================================================================

/**
 * Count character pairs in a list of words
 */
function countPairs(words: string[][]): Map<string, number> {
  const pairs = new Map<string, number>();

  for (const word of words) {
    for (let i = 0; i < word.length - 1; i++) {
      const pair = `${word[i]}|${word[i + 1]}`;
      pairs.set(pair, (pairs.get(pair) || 0) + 1);
    }
  }

  return pairs;
}

/**
 * Merge a pair in all words
 */
function mergePair(words: string[][], pair: [string, string]): string[][] {
  const [first, second] = pair;
  const merged = first + second;

  return words.map((word) => {
    const newWord: string[] = [];
    let i = 0;

    while (i < word.length) {
      if (i < word.length - 1 && word[i] === first && word[i + 1] === second) {
        newWord.push(merged);
        i += 2;
      } else {
        newWord.push(word[i]);
        i += 1;
      }
    }

    return newWord;
  });
}

/**
 * Train BPE vocabulary from token list
 */
export function trainBPE(
  tokens: string[],
  vocabSize: number = 5000,
  minFrequency: number = 2
): BPEVocab {
  // Initialize: split each token into characters
  let words = tokens.map((token) => token.split(''));
  const merges: [string, string][] = [];

  // Build initial vocabulary (all characters)
  const vocab = new Map<string, number>();
  let nextId = 0;

  for (const word of words) {
    for (const char of word) {
      if (!vocab.has(char)) {
        vocab.set(char, nextId++);
      }
    }
  }

  // Iteratively merge most frequent pairs
  const targetMerges = vocabSize - vocab.size;

  for (let i = 0; i < targetMerges; i++) {
    const pairs = countPairs(words);
    if (pairs.size === 0) break;

    // Find most frequent pair
    let maxPair = '';
    let maxCount = 0;

    for (const [pair, count] of pairs) {
      if (count > maxCount) {
        maxCount = count;
        maxPair = pair;
      }
    }

    // Stop if below minimum frequency
    if (maxCount < minFrequency) break;

    // Merge the pair
    const [first, second] = maxPair.split('|');
    const merged = first + second;

    words = mergePair(words, [first, second]);
    merges.push([first, second]);
    vocab.set(merged, nextId++);

    // Progress logging every 500 merges
    if ((i + 1) % 500 === 0) {
      console.log(`  BPE training: ${i + 1}/${targetMerges} merges`);
    }
  }

  return {
    merges,
    vocab,
    vocabSize: vocab.size,
    trainedAt: new Date().toISOString(),
    corpusSize: tokens.length,
  };
}

/**
 * Encode a token using trained BPE vocabulary
 */
export function encodeBPE(token: string, vocab: BPEVocab): string[] {
  let word = token.split('');

  // Apply merges in order
  for (const [first, second] of vocab.merges) {
    const merged = first + second;
    const newWord: string[] = [];
    let i = 0;

    while (i < word.length) {
      if (i < word.length - 1 && word[i] === first && word[i + 1] === second) {
        newWord.push(merged);
        i += 2;
      } else {
        newWord.push(word[i]);
        i += 1;
      }
    }

    word = newWord;
  }

  return word;
}

/**
 * Segment a flatcase identifier using BPE
 */
export function segmentWithBPE(word: string, vocab: BPEVocab): string[] {
  const segments = encodeBPE(word.toLowerCase(), vocab);

  // Filter out single characters (noise)
  return segments.filter((s) => s.length >= 2);
}

// ============================================================================
// Persistence
// ============================================================================

/**
 * Save BPE vocabulary to database
 */
export function saveBPEVocab(vocab: BPEVocab): void {
  if (isPostgresBackend()) return; // BPE tables only exist in SQLite
  const vocabArray = Array.from(vocab.vocab.entries());
  saveBPEVocabToDb(
    JSON.stringify(vocab.merges),
    JSON.stringify(vocabArray),
    vocab.vocabSize,
    vocab.corpusSize,
    vocab.trainedAt,
  );
}

/**
 * Load BPE vocabulary from database
 */
export function loadBPEVocab(): BPEVocab | null {
  if (isPostgresBackend()) return null; // BPE tables only exist in SQLite
  const row = loadBPEVocabFromDb();
  if (!row) return null;

  return {
    merges: JSON.parse(row.merges),
    vocab: new Map(JSON.parse(row.vocab)),
    vocabSize: row.vocab_size,
    trainedAt: row.trained_at,
    corpusSize: row.corpus_size,
  };
}

/**
 * Get last BPE training timestamp
 */
export function getLastBPETrainTime(): string | null {
  if (isPostgresBackend()) return null; // BPE tables only exist in SQLite
  return getLastBPETrainTimeFromDb();
}

/**
 * Check if BPE needs retraining
 */
export function needsBPERetrain(
  interval: 'hourly' | 'daily',
  lastIndexTime?: string
): boolean {
  const lastTrained = getLastBPETrainTime();
  if (!lastTrained) return true;

  const lastTrainedDate = new Date(lastTrained);
  const now = new Date();

  // Check interval
  const hoursDiff = (now.getTime() - lastTrainedDate.getTime()) / (1000 * 60 * 60);

  if (interval === 'hourly') {
    // Retrain if > 1 hour AND new code was indexed
    if (hoursDiff >= 1 && lastIndexTime) {
      const lastIndexDate = new Date(lastIndexTime);
      return lastIndexDate > lastTrainedDate;
    }
    // Always retrain if > 24 hours (daily maintenance)
    return hoursDiff >= 24;
  } else {
    // Daily: retrain if > 24 hours
    return hoursDiff >= 24;
  }
}

// ============================================================================
// Training from Database
// ============================================================================

/**
 * Train BPE from token_frequencies table.
 *
 * Uses already segmented Ronin-style tokens as base, so BPE learns
 * to merge meaningful word parts rather than starting from raw characters.
 *
 * This gives better results because:
 * 1. Tokens are already meaningful words (get, user, name, etc.)
 * 2. BPE learns common word combinations (getUser, userName, etc.)
 * 3. Much faster - uses pre-computed frequencies instead of scanning all code
 */
export async function trainBPEFromDatabase(
  vocabSize: number = 5000,
  minFrequency: number = 2
): Promise<BPEVocab | null> {
  // Get stats to check if we have enough data
  const stats = await getTokenFrequencyStats();

  if (stats.unique_tokens === 0) {
    console.log('No tokens indexed, skipping BPE training');
    console.log('Run `succ index-code` first to collect token frequencies.');
    return null;
  }

  if (stats.unique_tokens < 100) {
    console.log(`Only ${stats.unique_tokens} unique tokens, need at least 100 for BPE training`);
    return null;
  }

  console.log(`Training BPE from token_frequencies table...`);
  console.log(`  Unique tokens: ${stats.unique_tokens.toLocaleString()}`);
  console.log(`  Total occurrences: ${stats.total_occurrences.toLocaleString()}`);

  // Get top tokens (limit to reasonable amount for BPE training)
  // More tokens = better coverage, but slower training
  const maxTokens = Math.min(50000, stats.unique_tokens);
  const topTokens = await getTopTokens(maxTokens);

  // Expand tokens by frequency to create training corpus
  // Token with freq=100 appears 100 times in corpus
  const allTokens: string[] = [];
  for (const { token, frequency } of topTokens) {
    // Only include tokens that look like identifiers (letters only, >= 2 chars)
    if (/^[a-z]{2,}$/.test(token)) {
      // Cap frequency to avoid memory issues (max 1000 occurrences per token)
      const count = Math.min(frequency, 1000);
      for (let i = 0; i < count; i++) {
        allTokens.push(token);
      }
    }
  }

  if (allTokens.length < 100) {
    console.log('Not enough valid tokens for BPE training');
    return null;
  }

  console.log(`  Training corpus: ${allTokens.length.toLocaleString()} token occurrences`);

  // Train BPE
  const vocab = trainBPE(allTokens, vocabSize, minFrequency);

  // Save to database
  saveBPEVocab(vocab);

  console.log(`BPE trained: ${vocab.vocabSize} vocab size, ${vocab.merges.length} merges`);

  return vocab;
}

/**
 * AI-Readiness Score Command
 *
 * Shows how "ready" a project is for AI collaboration.
 */

import { calculateAIReadinessScore, formatAIReadinessScore } from '../lib/ai-readiness.js';
import { closeDb } from '../lib/storage/index.js';
import { logError } from '../lib/fault-logger.js';

export interface ScoreOptions {
  json?: boolean;
}

export async function score(options: ScoreOptions = {}): Promise<void> {
  try {
    const result = await calculateAIReadinessScore();

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatAIReadinessScore(result));
    }
  } catch (error: any) {
    logError(
      'score',
      `Error calculating score:: ${error.message}`,
      error instanceof Error ? error : undefined
    );

    console.error('Error calculating score:', error.message);
    process.exit(1);
  } finally {
    closeDb();
  }
}

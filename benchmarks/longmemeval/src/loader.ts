/**
 * Dataset loader — download and parse LongMemEval from HuggingFace
 */

import { readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';
import type { LongMemEvalQuestion, DatasetVariant } from './types.js';
import { DATASET_URLS } from './types.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data');

function getDatasetPath(variant: DatasetVariant): string {
  return join(DATA_DIR, `longmemeval_${variant}.json`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download dataset from HuggingFace if not cached locally
 */
export async function downloadDataset(variant: DatasetVariant): Promise<string> {
  const path = getDatasetPath(variant);

  if (await fileExists(path)) {
    console.log(`Dataset ${variant} already cached at ${path}`);
    return path;
  }

  const url = DATASET_URLS[variant];
  console.log(`Downloading ${variant} dataset from ${url}...`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }

  const data = await response.text();
  await writeFile(path, data, 'utf-8');
  console.log(`Saved to ${path} (${(data.length / 1024 / 1024).toFixed(1)} MB)`);

  return path;
}

/**
 * Load and parse dataset into typed questions
 */
export async function loadDataset(variant: DatasetVariant): Promise<LongMemEvalQuestion[]> {
  const path = getDatasetPath(variant);

  if (!(await fileExists(path))) {
    await downloadDataset(variant);
  }

  const raw = await readFile(path, 'utf-8');
  const data = JSON.parse(raw) as LongMemEvalQuestion[];

  console.log(`Loaded ${data.length} questions from ${variant} dataset`);

  // Validate
  const types = new Set(data.map(q => q.question_type));
  const typeCounts: Record<string, number> = {};
  for (const q of data) {
    typeCounts[q.question_type] = (typeCounts[q.question_type] || 0) + 1;
  }
  console.log('Question types:', typeCounts);

  return data;
}

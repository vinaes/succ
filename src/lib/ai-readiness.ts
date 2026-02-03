/**
 * AI-Readiness Score
 *
 * Measures how "ready" a project is for AI collaboration.
 *
 * Metrics (Total: 100%):
 * - Brain Vault: 25% - CLAUDE.md exists, folder structure
 * - Memory Coverage: 20% - Memories vs project size
 * - Code Index: 20% - % of source files indexed
 * - Soul Document: 10% - soul.md exists and complete
 * - Hooks Active: 10% - session-start/end configured
 * - Doc Index: 10% - Markdown docs indexed
 * - Quality Average: 5% - Average memory quality score
 */

import fs from 'fs';
import path from 'path';
import { getSuccDir, getProjectRoot } from './config.js';
import { getDb, getMemoryStats, getStats, getGraphStats } from './db.js';

// Metric weights (must sum to 100)
export const METRIC_WEIGHTS = {
  brain_vault: 25,
  memory_coverage: 20,
  code_index: 20,
  soul_document: 10,
  hooks_active: 10,
  doc_index: 10,
  quality_average: 5,
} as const;

export type MetricName = keyof typeof METRIC_WEIGHTS;

export interface MetricResult {
  name: MetricName;
  label: string;
  score: number;       // Points earned (out of max)
  maxScore: number;    // Maximum possible points
  details: string;     // Human-readable details
  suggestions?: string[];  // Suggestions for improvement
}

export interface AIReadinessScore {
  totalScore: number;  // 0-100
  maxScore: number;    // Always 100
  stars: number;       // 1-5 stars
  metrics: MetricResult[];
  suggestions: string[];
}

/**
 * Calculate brain vault score (25 points max)
 * - CLAUDE.md exists: 10 points
 * - brain/ folder structure: 5 points
 * - Number of docs (1+ = 5 points, 5+ = 10 points)
 */
export function calculateBrainVaultScore(): MetricResult {
  const succDir = getSuccDir();
  const brainDir = path.join(succDir, 'brain');
  const maxScore = METRIC_WEIGHTS.brain_vault;

  let score = 0;
  const details: string[] = [];
  const suggestions: string[] = [];

  // Check CLAUDE.md
  const claudeMdPaths = [
    path.join(succDir, 'CLAUDE.md'),
    path.join(getProjectRoot(), 'CLAUDE.md'),
  ];
  const claudeMdExists = claudeMdPaths.some(p => fs.existsSync(p));
  if (claudeMdExists) {
    score += 10;
    details.push('CLAUDE.md exists');
  } else {
    suggestions.push('Create CLAUDE.md with project-specific instructions');
  }

  // Check brain folder structure
  if (fs.existsSync(brainDir)) {
    score += 5;
    details.push('brain/ folder exists');

    // Count markdown files in brain
    const mdFiles = countMarkdownFiles(brainDir);
    if (mdFiles >= 5) {
      score += 10;
      details.push(`${mdFiles} docs in brain/`);
    } else if (mdFiles >= 1) {
      score += 5;
      details.push(`${mdFiles} docs in brain/`);
      suggestions.push('Add more documentation to .succ/brain/');
    } else {
      suggestions.push('Add documentation files to .succ/brain/');
    }
  } else {
    suggestions.push('Run `succ init` to create brain vault structure');
  }

  return {
    name: 'brain_vault',
    label: 'Brain Vault',
    score,
    maxScore,
    details: details.join(', ') || 'Not configured',
    suggestions: suggestions.length > 0 ? suggestions : undefined,
  };
}

/**
 * Calculate memory coverage score (20 points max)
 * Based on number of memories relative to project age/size
 * - 0 memories: 0 points
 * - 1-10 memories: 5 points
 * - 11-50 memories: 10 points
 * - 51-100 memories: 15 points
 * - 100+ memories: 20 points
 */
export function calculateMemoryCoverageScore(): MetricResult {
  const maxScore = METRIC_WEIGHTS.memory_coverage;

  try {
    const memStats = getMemoryStats();
    const total = memStats.total_memories;

    let score = 0;
    if (total >= 100) score = 20;
    else if (total >= 51) score = 15;
    else if (total >= 11) score = 10;
    else if (total >= 1) score = 5;

    const suggestions: string[] = [];
    if (total < 10) {
      suggestions.push('Use succ_remember to save learnings and decisions');
    }
    if (total < 50) {
      suggestions.push('Continue building memory knowledge base');
    }

    return {
      name: 'memory_coverage',
      label: 'Memory Coverage',
      score,
      maxScore,
      details: `${total} memories`,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
  } catch {
    return {
      name: 'memory_coverage',
      label: 'Memory Coverage',
      score: 0,
      maxScore,
      details: 'No memories',
      suggestions: ['Initialize succ and start saving memories'],
    };
  }
}

/**
 * Calculate code index score (20 points max)
 * Based on % of source files indexed
 * - 0%: 0 points
 * - 1-25%: 5 points
 * - 26-50%: 10 points
 * - 51-75%: 15 points
 * - 76-100%: 20 points
 */
export function calculateCodeIndexScore(): MetricResult {
  const maxScore = METRIC_WEIGHTS.code_index;
  const projectRoot = getProjectRoot();

  try {
    // Count source files in project
    const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java'];
    const totalSourceFiles = countSourceFiles(projectRoot, sourceExtensions);

    // Get indexed code chunks from DB
    const db = getDb();
    const indexedFiles = db.prepare("SELECT COUNT(DISTINCT file_path) as count FROM documents WHERE file_path LIKE 'code:%'").get() as { count: number };
    const indexedCount = indexedFiles.count;

    if (totalSourceFiles === 0) {
      return {
        name: 'code_index',
        label: 'Code Index',
        score: maxScore, // Full score if no source files
        maxScore,
        details: 'No source files to index',
      };
    }

    const percentage = Math.round((indexedCount / totalSourceFiles) * 100);
    let score = 0;
    if (percentage >= 76) score = 20;
    else if (percentage >= 51) score = 15;
    else if (percentage >= 26) score = 10;
    else if (percentage >= 1) score = 5;

    const suggestions: string[] = [];
    if (percentage < 50) {
      suggestions.push('Run `succ index-code` to index source files');
    }

    return {
      name: 'code_index',
      label: 'Code Index',
      score,
      maxScore,
      details: `${percentage}% indexed (${indexedCount}/${totalSourceFiles} files)`,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
  } catch {
    return {
      name: 'code_index',
      label: 'Code Index',
      score: 0,
      maxScore,
      details: 'Not indexed',
      suggestions: ['Run `succ index-code` to index source files'],
    };
  }
}

/**
 * Calculate soul document score (10 points max)
 * - soul.md exists: 5 points
 * - soul.md has custom content (not just template): 5 points
 */
export function calculateSoulDocumentScore(): MetricResult {
  const succDir = getSuccDir();
  const maxScore = METRIC_WEIGHTS.soul_document;

  const soulPaths = [
    path.join(succDir, 'soul.md'),
    path.join(succDir, 'SOUL.md'),
    path.join(getProjectRoot(), 'soul.md'),
    path.join(getProjectRoot(), 'SOUL.md'),
  ];

  let soulPath: string | null = null;
  for (const p of soulPaths) {
    if (fs.existsSync(p)) {
      soulPath = p;
      break;
    }
  }

  if (!soulPath) {
    return {
      name: 'soul_document',
      label: 'Soul Document',
      score: 0,
      maxScore,
      details: 'Not found',
      suggestions: ['Create soul.md to define your AI collaboration style'],
    };
  }

  const content = fs.readFileSync(soulPath, 'utf8');
  const hasCustomContent = checkSoulCustomization(content);

  const score = hasCustomContent ? 10 : 5;
  const details = hasCustomContent ? 'Complete' : 'Exists but incomplete';

  return {
    name: 'soul_document',
    label: 'Soul Document',
    score,
    maxScore,
    details,
    suggestions: hasCustomContent ? undefined : ['Customize your soul.md with personal preferences'],
  };
}

/**
 * Calculate hooks active score (10 points max)
 * - session-start hook configured: 5 points
 * - session-end hook configured: 5 points
 */
export function calculateHooksActiveScore(): MetricResult {
  const succDir = getSuccDir();
  const hooksDir = path.join(succDir, 'hooks');
  const maxScore = METRIC_WEIGHTS.hooks_active;

  let score = 0;
  const details: string[] = [];
  const suggestions: string[] = [];

  // Check session-start hook
  const sessionStartPaths = [
    path.join(hooksDir, 'succ-session-start.cjs'),
    path.join(hooksDir, 'session-start.cjs'),
    path.join(hooksDir, 'session-start.js'),
  ];
  const hasSessionStart = sessionStartPaths.some(p => fs.existsSync(p));
  if (hasSessionStart) {
    score += 5;
    details.push('session-start');
  } else {
    suggestions.push('Configure session-start hook for context injection');
  }

  // Check session-end hook (or idle watcher)
  const sessionEndPaths = [
    path.join(hooksDir, 'succ-session-end.cjs'),
    path.join(hooksDir, 'succ-idle-watcher.cjs'),
    path.join(hooksDir, 'session-end.cjs'),
    path.join(hooksDir, 'session-end.js'),
  ];
  const hasSessionEnd = sessionEndPaths.some(p => fs.existsSync(p));
  if (hasSessionEnd) {
    score += 5;
    details.push('session-end/idle');
  } else {
    suggestions.push('Configure idle watcher for automatic reflection');
  }

  return {
    name: 'hooks_active',
    label: 'Hooks Active',
    score,
    maxScore,
    details: details.length > 0 ? details.join(', ') : 'None configured',
    suggestions: suggestions.length > 0 ? suggestions : undefined,
  };
}

/**
 * Calculate doc index score (10 points max)
 * Based on % of markdown files in brain/ that are indexed
 */
export function calculateDocIndexScore(): MetricResult {
  const succDir = getSuccDir();
  const brainDir = path.join(succDir, 'brain');
  const maxScore = METRIC_WEIGHTS.doc_index;

  if (!fs.existsSync(brainDir)) {
    return {
      name: 'doc_index',
      label: 'Doc Index',
      score: 0,
      maxScore,
      details: 'No brain/ folder',
      suggestions: ['Run `succ init` to create brain vault'],
    };
  }

  try {
    // Count markdown files in brain
    const totalMdFiles = countMarkdownFiles(brainDir);

    if (totalMdFiles === 0) {
      return {
        name: 'doc_index',
        label: 'Doc Index',
        score: maxScore, // Full score if nothing to index
        maxScore,
        details: 'No docs to index',
      };
    }

    // Get indexed doc chunks from DB
    const db = getDb();
    const stats = getStats();
    const indexedDocs = stats.total_files;

    // Estimate indexed count (exclude code: prefix files)
    const nonCodeDocs = db.prepare("SELECT COUNT(DISTINCT file_path) as count FROM documents WHERE file_path NOT LIKE 'code:%'").get() as { count: number };
    const indexedCount = nonCodeDocs.count;

    const percentage = Math.round((indexedCount / totalMdFiles) * 100);
    let score = 0;
    if (percentage >= 80) score = 10;
    else if (percentage >= 50) score = 7;
    else if (percentage >= 20) score = 4;
    else if (percentage >= 1) score = 2;

    const suggestions: string[] = [];
    if (percentage < 80) {
      suggestions.push('Run `succ index` to index remaining docs');
    }

    return {
      name: 'doc_index',
      label: 'Doc Index',
      score,
      maxScore,
      details: `${indexedCount}/${totalMdFiles} files indexed`,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
  } catch {
    return {
      name: 'doc_index',
      label: 'Doc Index',
      score: 0,
      maxScore,
      details: 'Not indexed',
      suggestions: ['Run `succ index` to index brain vault docs'],
    };
  }
}

/**
 * Calculate quality average score (5 points max)
 * Based on average quality score of memories
 * - No quality scores: 0 points
 * - Avg < 0.3: 1 point
 * - Avg 0.3-0.5: 2 points
 * - Avg 0.5-0.7: 3 points
 * - Avg 0.7-0.85: 4 points
 * - Avg >= 0.85: 5 points
 */
export function calculateQualityAverageScore(): MetricResult {
  const maxScore = METRIC_WEIGHTS.quality_average;

  try {
    const db = getDb();
    const result = db.prepare(`
      SELECT AVG(quality_score) as avg_quality, COUNT(*) as count
      FROM memories
      WHERE quality_score IS NOT NULL
    `).get() as { avg_quality: number | null; count: number };

    if (!result.avg_quality || result.count === 0) {
      return {
        name: 'quality_average',
        label: 'Quality Average',
        score: 0,
        maxScore,
        details: 'No quality scores',
        suggestions: ['Enable quality scoring for memories'],
      };
    }

    const avg = result.avg_quality;
    let score = 0;
    if (avg >= 0.85) score = 5;
    else if (avg >= 0.7) score = 4;
    else if (avg >= 0.5) score = 3;
    else if (avg >= 0.3) score = 2;
    else score = 1;

    const suggestions: string[] = [];
    if (avg < 0.5) {
      suggestions.push('Focus on saving higher-quality memories');
    }

    return {
      name: 'quality_average',
      label: 'Quality Average',
      score,
      maxScore,
      details: `${(avg * 100).toFixed(0)}% avg (${result.count} scored)`,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
  } catch {
    return {
      name: 'quality_average',
      label: 'Quality Average',
      score: 0,
      maxScore,
      details: 'Not available',
      suggestions: ['Enable quality scoring'],
    };
  }
}

/**
 * Calculate full AI-Readiness Score
 */
export function calculateAIReadinessScore(): AIReadinessScore {
  const metrics: MetricResult[] = [
    calculateBrainVaultScore(),
    calculateMemoryCoverageScore(),
    calculateCodeIndexScore(),
    calculateSoulDocumentScore(),
    calculateHooksActiveScore(),
    calculateDocIndexScore(),
    calculateQualityAverageScore(),
  ];

  const totalScore = metrics.reduce((sum, m) => sum + m.score, 0);
  const maxScore = 100;

  // Calculate stars (1-5)
  let stars = 1;
  if (totalScore >= 90) stars = 5;
  else if (totalScore >= 75) stars = 4;
  else if (totalScore >= 50) stars = 3;
  else if (totalScore >= 25) stars = 2;

  // Collect all suggestions, prioritized by impact
  const allSuggestions: string[] = [];
  const metricsByMissingPoints = [...metrics].sort((a, b) => (b.maxScore - b.score) - (a.maxScore - a.score));

  for (const metric of metricsByMissingPoints) {
    if (metric.suggestions) {
      allSuggestions.push(...metric.suggestions);
    }
  }

  // Dedupe and limit suggestions
  const uniqueSuggestions = [...new Set(allSuggestions)].slice(0, 5);

  return {
    totalScore,
    maxScore,
    stars,
    metrics,
    suggestions: uniqueSuggestions,
  };
}

/**
 * Format score for display
 */
export function formatAIReadinessScore(result: AIReadinessScore): string {
  const lines: string[] = [];

  // Header with stars
  const starDisplay = '\u2B50'.repeat(result.stars);
  lines.push(`AI-Readiness Score: ${result.totalScore}/${result.maxScore} ${starDisplay}`);
  lines.push('');

  // Metrics breakdown
  for (const metric of result.metrics) {
    const check = metric.score === metric.maxScore ? '\u2713' : ' ';
    const scoreStr = `${metric.score}/${metric.maxScore}`.padStart(5);
    const label = metric.label.padEnd(16);
    lines.push(`  ${label} ${scoreStr}  ${check} ${metric.details}`);
  }

  // Suggestions
  if (result.suggestions.length > 0) {
    lines.push('');
    lines.push('Suggestions:');
    for (const suggestion of result.suggestions) {
      lines.push(`  - ${suggestion}`);
    }
  }

  return lines.join('\n');
}

// Helper functions

function countMarkdownFiles(dir: string): number {
  let count = 0;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        count += countMarkdownFiles(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        count++;
      }
    }
  } catch {
    // Ignore errors
  }

  return count;
}

function countSourceFiles(dir: string, extensions: string[]): number {
  let count = 0;

  // Directories to skip
  const skipDirs = ['node_modules', '.git', 'dist', 'build', '.succ', '.claude', 'vendor', '__pycache__'];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !skipDirs.includes(entry.name) && !entry.name.startsWith('.')) {
        count += countSourceFiles(path.join(dir, entry.name), extensions);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.includes(ext)) {
          count++;
        }
      }
    }
  } catch {
    // Ignore errors
  }

  return count;
}

function checkSoulCustomization(content: string): boolean {
  // Check if soul.md has been customized beyond the template
  // Template markers that indicate it's still a template
  const templateMarkers = [
    '_Add your preferences here',
    'Preferred frameworks:',
    'Code style:',
    'Testing approach:',
    'Communication language:',
  ];

  // Check if all template markers are still present (means not customized)
  const hasAllMarkers = templateMarkers.every(marker => content.includes(marker));

  // Check if there's substantial custom content
  const lines = content.split('\n').filter(line => line.trim().length > 0);
  const hasSubstantialContent = lines.length > 30;

  // Check for custom sections (not in default template)
  const hasCustomSections = content.includes('## My Preferences') ||
    content.includes('## About Me') ||
    content.includes('## Code Style') ||
    (content.includes('Preferred frameworks:') && !!content.match(/Preferred frameworks:\s*\S+/));

  return !hasAllMarkers || hasSubstantialContent || hasCustomSections;
}

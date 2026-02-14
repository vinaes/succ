/**
 * Quality Scoring for Memories
 *
 * Modes:
 * - local: ONNX-based zero-shot classification (no external API needed)
 * - custom: Ollama, LM Studio, llama.cpp (local LLM API)
 * - openrouter: OpenRouter API
 */

import { getConfig, getLLMTaskConfig, type SuccConfig } from './config.js';
import { QUALITY_SCORER_SYSTEM } from '../prompts/index.js';
import { logWarn } from './fault-logger.js';
import { NetworkError, ValidationError } from './errors.js';

// Lazy-loaded zero-shot classification pipeline for local scoring
let classifierPipeline: any = null;
const CLASSIFIER_MODEL = 'Xenova/nli-deberta-v3-xsmall';

// Labels for zero-shot classification
// Using single classification with optimized labels (31pp separation in benchmark)
const QUALITY_LABELS = {
  // Primary quality indicator - best performing labels from benchmark
  quality: [
    'specific technical detail with code or file references',
    'vague statement without concrete details',
  ],
  // Secondary checks for additional signal
  relevance: ['relevant to software development', 'not related to programming'],
};

export interface QualityScore {
  score: number; // 0-1, higher is better
  confidence: number; // 0-1, how confident we are in this score
  factors: {
    specificity: number; // How specific/actionable is the content
    clarity: number; // How clear and well-written
    relevance: number; // How relevant to the project context
    uniqueness: number; // How unique compared to existing memories
  };
  mode: 'local' | 'api' | 'heuristic';
}

/**
 * Heuristic-based quality scoring (no LLM needed)
 * Fast and works offline, but less accurate than LLM-based scoring
 */
export function scoreWithHeuristics(content: string, existingSimilarity?: number): QualityScore {
  const factors = {
    specificity: calculateSpecificity(content),
    clarity: calculateClarity(content),
    relevance: 0.5, // Can't determine without context, default to neutral
    uniqueness: existingSimilarity !== undefined ? 1 - existingSimilarity : 0.5,
  };

  // Weighted average
  const score =
    factors.specificity * 0.3 +
    factors.clarity * 0.3 +
    factors.relevance * 0.2 +
    factors.uniqueness * 0.2;

  return {
    score,
    confidence: 0.6, // Heuristics are less confident than LLM
    factors,
    mode: 'heuristic',
  };
}

/**
 * Calculate specificity score
 * Higher for content with specific details, lower for vague statements
 * Supports multiple languages: English, Russian, and code-agnostic patterns
 */
function calculateSpecificity(content: string): number {
  let score = 0.5; // Base score

  // Content length checks (more nuanced)
  const wordCount = content.trim().split(/\s+/).length;
  const charCount = content.length;

  // === POSITIVE SIGNALS (language-agnostic and multilingual) ===

  // Code patterns (universal)
  const hasNumbers = /\d+/.test(content);
  const hasCodeReference = /`[^`]+`|```[\s\S]*?```/.test(content);
  const hasFilePath =
    /\.(ts|js|tsx|jsx|py|go|rs|java|cpp|c|h|md|json|yaml|yml|sql|sh|bash|css|scss|html)\b/.test(
      content
    );
  const hasLineReference = /:\d+/.test(content); // file:line references
  const hasProperNouns = /[A-Z][a-z]+(?:[A-Z][a-z]+)+/.test(content); // CamelCase
  const hasSnakeCase = /[a-z]+_[a-z]+/.test(content); // snake_case identifiers

  // Technical terms - English
  const hasEnglishTechnicalTerms =
    /\b(function|class|method|variable|parameter|return|error|bug|fix|feature|api|endpoint|database|table|column|component|module|service|handler|controller|config|deploy|server|client|request|response|query|mutation|schema|model|view|route|middleware|hook|callback|promise|async|await)\b/i.test(
      content
    );

  // Technical terms - Russian
  const hasRussianTechnicalTerms =
    /\b(функция|класс|метод|переменная|параметр|ошибка|баг|фикс|исправлен|фича|апи|эндпоинт|база данных|таблица|колонка|компонент|модуль|сервис|хендлер|контроллер|конфиг|деплой|сервер|клиент|запрос|ответ|схема|модель|роут|миддлвар|хук|коллбэк|промис)\b/i.test(
      content
    );

  // Actionable verbs - English
  const hasEnglishActionableVerbs =
    /\b(implement|create|add|remove|fix|update|refactor|migrate|configure|deploy|test|resolve|optimize|integrate|delete|modify|change|setup|install|build|run|execute|debug|trace|log|handle|process|validate|parse|serialize|fetch|send|receive|connect|disconnect)\b/i.test(
      content
    );

  // Actionable verbs - Russian
  const hasRussianActionableVerbs =
    /\b(реализовать|создать|добавить|удалить|исправить|обновить|рефакторить|мигрировать|настроить|задеплоить|тестировать|решить|оптимизировать|интегрировать|изменить|установить|собрать|запустить|выполнить|дебажить|отладить|логировать|обработать|валидировать|парсить|сериализовать|отправить|получить|подключить)\b/i.test(
      content
    );

  // Preference/personal facts — short but high-value for recall
  const isPreferenceFact =
    /\b(user|i|he|she|they|we)\s+(use[sd]?|like[sd]?|prefer[sd]?|has|have|had|want[sd]?|chose|always|never|switch)/i.test(
      content
    ) ||
    /\b(пользователь|юзер|я|он|она|мы)\s+(использу[еюёт]|предпочита[еюёт]|любит|хоч[еу]т|выбрал|всегда|никогда)/i.test(
      content
    );

  if (hasNumbers) score += 0.1;
  if (hasCodeReference) score += 0.2;
  if (hasFilePath) score += 0.15;
  if (hasLineReference) score += 0.1;
  if (hasEnglishTechnicalTerms || hasRussianTechnicalTerms) score += 0.1;
  if (hasProperNouns || hasSnakeCase) score += 0.05;
  if (hasEnglishActionableVerbs || hasRussianActionableVerbs) score += 0.1;
  if (isPreferenceFact) score += 0.2;

  // === NEGATIVE SIGNALS (multilingual) ===

  // Vague words - English
  const isVagueEnglish =
    /\b(maybe|perhaps|somehow|something|stuff|things|whatever|somewhere|anyone|anything|some|kinda|sorta)\b/i.test(
      content
    );

  // Vague words - Russian
  const isVagueRussian =
    /\b(может быть|возможно|как-то|что-то|где-то|кто-то|как-нибудь|где-нибудь|что-нибудь|какой-то|некий|вроде|типа|наверное)\b/i.test(
      content
    );

  // Length checks
  const isTooShort = charCount < 30 || wordCount < 5;
  const isVeryShort = charCount < 15 || wordCount < 3;

  // Generic praise - English
  const isGenericEnglish =
    /\b(good|bad|nice|cool|great|interesting|awesome|works|fine|ok|okay|perfect|excellent)\b/i.test(
      content
    ) &&
    !/\b(good practice|bad pattern|nice feature|works well because|works by|good for)\b/i.test(
      content
    );

  // Generic praise - Russian (include adjective forms: хороший/хорошая/хорошее, плохой/плохая/плохое, etc.)
  const isGenericRussian =
    /\b(хорош[иоеая]{1,2}|плох[оиеая]{1,2}|отлично|отличн[ыоеая]{1,2}|круто|крут[оыеая]{1,2}|класс|классн[оыеая]{1,2}|супер|норм|нормальн[оыеая]{1,2}|работает|ок|окей|идеальн[оыеая]{1,2}|прекрасн[оыеая]{1,2})\b/i.test(
      content
    ) &&
    !/\b(хорошая практика|плохой паттерн|работает потому что|работает за счёт)\b/i.test(content);

  // Only generic praise patterns
  const isOnlyGenericPraiseEnglish =
    /^(the )?(code|it|this|that)?\s*(is|are|was|were)?\s*(good|nice|great|fine|ok|cool|awesome|works|working)/i.test(
      content.trim()
    );
  const isOnlyGenericPraiseRussian =
    /^(код|это|оно|всё)?\s*(хорош[иоеая]{0,2}|отлично|работает|норм|класс|супер)/i.test(
      content.trim()
    );

  const lacksSubstance = wordCount < 8 && !hasCodeReference && !hasFilePath && !hasNumbers;

  if (isVagueEnglish || isVagueRussian) score -= 0.2;
  // Reduce short-content penalties for preference facts (short but high-value)
  if (isPreferenceFact) {
    if (isVeryShort) score -= 0.15;
    else if (isTooShort) score -= 0.05;
  } else {
    if (isVeryShort) score -= 0.35;
    else if (isTooShort) score -= 0.2;
  }
  if (isGenericEnglish || isGenericRussian) score -= 0.15;
  if (isOnlyGenericPraiseEnglish || isOnlyGenericPraiseRussian) score -= 0.25;
  if (lacksSubstance && !isPreferenceFact) score -= 0.15;

  return Math.max(0, Math.min(1, score));
}

// ============================================================================
// Embedding-based specificity (language-agnostic fallback)
// ============================================================================

/**
 * Reference phrases for embedding-based specificity estimation.
 * High-specificity: technical, actionable, detailed.
 * Low-specificity: vague, generic, meaningless.
 */
const HIGH_SPECIFICITY_REFS = [
  'Implement JWT authentication middleware for the REST API endpoints',
  'Fix SQL injection vulnerability in the user registration handler',
  'Configure nginx reverse proxy with SSL termination on port 443',
  'Refactor the database schema to support multi-tenant isolation',
  'Add retry logic with exponential backoff for failed API requests',
];

const LOW_SPECIFICITY_REFS = [
  'This is good',
  'Something happened with the code',
  'Maybe we should change stuff',
  'It works fine I think',
];

const SPECIFICITY_HIGH_SET = 'specificity-high';
const SPECIFICITY_LOW_SET = 'specificity-low';
let _specificityRefsRegistered = false;

/**
 * Estimate content specificity using embedding similarity to reference phrases.
 * Returns 0-1 where higher = more specific/technical content.
 * Language-agnostic — works for any language the embedding model supports.
 */
export async function estimateSpecificityByEmbedding(content: string): Promise<number> {
  try {
    const { registerReferenceSet, avgSimilarityToReference } =
      await import('./reference-embeddings.js');
    const { getEmbedding } = await import('./embeddings.js');

    if (!_specificityRefsRegistered) {
      registerReferenceSet(SPECIFICITY_HIGH_SET, HIGH_SPECIFICITY_REFS);
      registerReferenceSet(SPECIFICITY_LOW_SET, LOW_SPECIFICITY_REFS);
      _specificityRefsRegistered = true;
    }

    const contentEmb = await getEmbedding(content);
    const [highSim, lowSim] = await Promise.all([
      avgSimilarityToReference(contentEmb, SPECIFICITY_HIGH_SET),
      avgSimilarityToReference(contentEmb, SPECIFICITY_LOW_SET),
    ]);

    // Clamp negatives (cosine range is -1..1), then normalize
    const clampedHigh = Math.max(0, highSim);
    const clampedLow = Math.max(0, lowSim);
    const total = clampedHigh + clampedLow;
    if (total === 0) return 0.5;
    return clampedHigh / total;
  } catch {
    return 0.5; // neutral fallback
  }
}

/**
 * Clear cached specificity reference embeddings (for tests).
 */
export function clearSpecificityEmbeddingCache(): void {
  _specificityRefsRegistered = false;
}

/**
 * Calculate clarity score
 * Higher for well-structured, readable content
 */
function calculateClarity(content: string): number {
  let score = 0.5;

  // Positive signals
  const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const avgSentenceLength = content.length / Math.max(sentences.length, 1);
  const hasGoodLength = avgSentenceLength >= 30 && avgSentenceLength <= 150;

  const hasStructure = /^[-*•]|\n[-*•]|\n\d+\./.test(content); // Lists
  const hasSeparators = /\n{2,}|:\s*\n/.test(content); // Paragraphs
  const hasProperPunctuation = /[.!?]$/.test(content.trim());

  if (hasGoodLength) score += 0.15;
  if (hasStructure) score += 0.1;
  if (hasSeparators) score += 0.05;
  if (hasProperPunctuation) score += 0.1;

  // Negative signals
  const hasExcessiveCaps = (content.match(/[A-Z]{3,}/g) || []).length > 2;
  const hasNoSpaces = content.length > 50 && !content.includes(' ');
  const hasRepeatedChars = /(.)\1{4,}/.test(content);

  if (hasExcessiveCaps) score -= 0.1;
  if (hasNoSpaces) score -= 0.3;
  if (hasRepeatedChars) score -= 0.2;

  return Math.max(0, Math.min(1, score));
}

/**
 * Get the zero-shot classification pipeline (lazy loaded)
 */
async function getClassifierPipeline() {
  if (!classifierPipeline) {
    const { pipeline } = await import('@huggingface/transformers');
    console.log(`Loading quality scoring model: ${CLASSIFIER_MODEL}...`);
    classifierPipeline = await pipeline('zero-shot-classification', CLASSIFIER_MODEL, {
      device: 'cpu',
    });
    console.log('Quality scoring model loaded.');
  }
  return classifierPipeline;
}

/**
 * Cleanup classifier pipeline to free memory
 */
export function cleanupQualityScoring(): void {
  if (classifierPipeline) {
    classifierPipeline = null;
    if (global.gc) {
      global.gc();
    }
  }
}

/**
 * Score memory using local ONNX model (zero-shot classification)
 * Uses Xenova/nli-deberta-v3-xsmall for efficient classification
 *
 * Hybrid approach: combines ONNX classification with heuristic checks
 * - ONNX is good at detecting technical content with code references
 * - Heuristics act as a "gate" - if content fails basic quality checks, cap the score
 */
export async function scoreWithLocal(
  content: string,
  existingSimilarity?: number
): Promise<QualityScore> {
  try {
    // First, run quick heuristic checks
    const heuristicResult = scoreWithHeuristics(content, existingSimilarity);

    // If heuristic specificity is uncertain (< 0.5), try embedding-based estimation.
    // This helps non-EN/RU content that heuristic regex can't score fairly.
    if (heuristicResult.factors.specificity < 0.5) {
      try {
        const embSpec = await estimateSpecificityByEmbedding(content);
        if (embSpec > heuristicResult.factors.specificity) {
          heuristicResult.factors.specificity = embSpec;
          // Recalculate overall score with updated specificity
          heuristicResult.score =
            heuristicResult.factors.specificity * 0.3 +
            heuristicResult.factors.clarity * 0.3 +
            heuristicResult.factors.relevance * 0.2 +
            heuristicResult.factors.uniqueness * 0.2;
        }
      } catch {
        // Non-fatal — continue with heuristic score
      }
    }

    // If content is clearly low quality by heuristics, don't bother with ONNX
    // This catches: too short, vague words, generic praise, etc.
    if (heuristicResult.factors.specificity < 0.4) {
      return { ...heuristicResult, mode: 'local' }; // Return heuristic score but mark as local
    }

    const classifier = await getClassifierPipeline();

    // Run zero-shot classification for quality and relevance
    const [qualityResult, relevanceResult] = await Promise.all([
      classifier(content, QUALITY_LABELS.quality, { multi_label: false }),
      classifier(content, QUALITY_LABELS.relevance, { multi_label: false }),
    ]);

    // Extract ONNX scores
    const onnxQuality =
      qualityResult.scores[qualityResult.labels.indexOf(QUALITY_LABELS.quality[0])];
    const onnxRelevance =
      relevanceResult.scores[relevanceResult.labels.indexOf(QUALITY_LABELS.relevance[0])];

    // Uniqueness from similarity if provided
    const uniqueness = existingSimilarity !== undefined ? 1 - existingSimilarity : 0.5;

    // Combine ONNX with heuristics
    // Use minimum of ONNX and heuristic specificity to catch edge cases
    const specificity = Math.min(onnxQuality, heuristicResult.factors.specificity + 0.15);

    const factors = {
      specificity,
      clarity: heuristicResult.factors.clarity,
      relevance: onnxRelevance,
      uniqueness,
    };

    // Weighted average for overall score
    const score =
      factors.specificity * 0.35 + // Hybrid specificity
      factors.clarity * 0.15 + // Heuristic clarity
      factors.relevance * 0.25 + // ONNX relevance
      factors.uniqueness * 0.25; // Similarity-based uniqueness

    return {
      score: clamp(score, 0, 1),
      confidence: 0.85,
      factors,
      mode: 'local',
    };
  } catch (error) {
    // Fall back to heuristics if model fails
    logWarn('quality', 'Local ONNX scoring failed, falling back to heuristics', {
      error: String(error),
    });
    return scoreWithHeuristics(content, existingSimilarity);
  }
}

/**
 * Score memory using any OpenAI-compatible API (Ollama, OpenRouter, LM Studio, etc.)
 * Auto-adds OpenRouter-specific headers when api_url contains 'openrouter.ai'.
 */
export async function scoreWithApi(
  content: string,
  apiUrl: string,
  model: string,
  apiKey?: string
): Promise<QualityScore> {
  const prompt = buildScoringPrompt(content);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  if (apiUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://succ.ai';
    headers['X-Title'] = 'succ';
  }

  try {
    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: QUALITY_SCORER_SYSTEM },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 200,
      }),
    });

    if (!response.ok) {
      throw new NetworkError(`API error: ${response.status}`, response.status);
    }

    const data = await response.json();
    const result = parseScoreResponse(data.choices[0]?.message?.content || '');
    return { ...result, mode: 'api' };
  } catch (error) {
    logWarn('quality', 'API scoring failed, falling back to heuristics', { error: String(error) });
    return scoreWithHeuristics(content);
  }
}

/**
 * Build the prompt for LLM-based scoring
 */
function buildScoringPrompt(content: string): string {
  return `Rate the quality of this development memory on a scale of 0 to 1.

Memory content:
"""
${content}
"""

Evaluate these factors (each 0-1):
- specificity: How specific and actionable is the content?
- clarity: How clear and well-written is it?
- relevance: How relevant is this to software development?
- uniqueness: How unique/non-obvious is this insight?

Respond with JSON only:
{
  "score": <overall 0-1>,
  "confidence": <your confidence 0-1>,
  "factors": {
    "specificity": <0-1>,
    "clarity": <0-1>,
    "relevance": <0-1>,
    "uniqueness": <0-1>
  }
}`;
}

/**
 * Parse LLM response to QualityScore
 */
function parseScoreResponse(response: string): Omit<QualityScore, 'mode'> {
  try {
    // Extract JSON from response (may have markdown wrapping)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new ValidationError('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      score: clamp(parsed.score || 0.5, 0, 1),
      confidence: clamp(parsed.confidence || 0.8, 0, 1),
      factors: {
        specificity: clamp(parsed.factors?.specificity || 0.5, 0, 1),
        clarity: clamp(parsed.factors?.clarity || 0.5, 0, 1),
        relevance: clamp(parsed.factors?.relevance || 0.5, 0, 1),
        uniqueness: clamp(parsed.factors?.uniqueness || 0.5, 0, 1),
      },
    };
  } catch {
    // Return default scores on parse error
    return {
      score: 0.5,
      confidence: 0.3,
      factors: {
        specificity: 0.5,
        clarity: 0.5,
        relevance: 0.5,
        uniqueness: 0.5,
      },
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Main scoring function - uses configured mode from llm.quality.*
 */
export async function scoreMemory(
  content: string,
  existingSimilarity?: number,
  configOverride?: Partial<SuccConfig>
): Promise<QualityScore> {
  const config = { ...getConfig(), ...configOverride };

  // If scoring disabled, return neutral score
  if (config.quality_scoring_enabled === false) {
    return {
      score: 0.5,
      confidence: 1,
      factors: { specificity: 0.5, clarity: 0.5, relevance: 0.5, uniqueness: 0.5 },
      mode: 'heuristic',
    };
  }

  const taskCfg = getLLMTaskConfig('quality');

  switch (taskCfg.mode) {
    case 'local':
      return scoreWithLocal(content);

    case 'api':
      if (!taskCfg.model) {
        logWarn('quality', 'API scoring requires llm.quality.model');
        return scoreWithHeuristics(content, existingSimilarity);
      }
      return scoreWithApi(content, taskCfg.api_url, taskCfg.model, taskCfg.api_key);

    default:
      return scoreWithHeuristics(content, existingSimilarity);
  }
}

/**
 * Check if memory passes quality threshold
 */
export function passesQualityThreshold(score: QualityScore, threshold?: number): boolean {
  const config = getConfig();
  const minScore = threshold ?? config.quality_scoring_threshold ?? 0;
  return score.score >= minScore;
}

/**
 * Format quality score for display
 */
export function formatQualityScore(score: QualityScore): string {
  const percent = Math.round(score.score * 100);
  const stars = Math.round(score.score * 5);
  const starStr = '★'.repeat(stars) + '☆'.repeat(5 - stars);

  return `${starStr} ${percent}% (${score.mode})`;
}

/**
 * LongMemEval benchmark types
 *
 * Based on the official LongMemEval dataset (ICLR 2025)
 * https://github.com/xiaowu0162/LongMemEval
 */

// ============================================================================
// Dataset Types
// ============================================================================

export type QuestionType =
  | 'single-session-user'
  | 'single-session-assistant'
  | 'single-session-preference'
  | 'temporal-reasoning'
  | 'knowledge-update'
  | 'multi-session';

export type DatasetVariant = 's' | 'm' | 'oracle';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  has_answer?: boolean;
}

export interface LongMemEvalQuestion {
  question_id: string;
  question_type: QuestionType;
  question: string;
  answer: string;
  question_date?: string;
  haystack_session_ids: number[];
  haystack_dates: string[];
  haystack_sessions: ConversationTurn[][];
  answer_session_ids: number[];
}

// ============================================================================
// Result Types
// ============================================================================

export interface BenchmarkResult {
  question_id: string;
  question_type: QuestionType;
  question: string;
  expected_answer: string;
  hypothesis: string;
  is_correct: boolean;
  memories_retrieved: number;
  memories_total: number;
  elapsed_ms: number;
  model: string;
}

export interface BenchmarkMetrics {
  total_questions: number;
  correct_answers: number;
  overall_accuracy: number;
  accuracy_by_type: Record<QuestionType, {
    correct: number;
    total: number;
    accuracy: number;
  }>;
  model: string;
  dataset: DatasetVariant;
  timestamp: string;
}

// ============================================================================
// Config Types
// ============================================================================

export type AnswerModel = 'gpt-4o' | 'sonnet';

export interface RunOptions {
  dataset: DatasetVariant;
  model: AnswerModel;
  subset?: number;
  offset?: number;
  questionType?: QuestionType;
  questionId?: string;
  concurrency: number;
  mode: 'extract' | 'direct';
  topK: number;
  resume?: boolean;
}

export const MODEL_CONFIGS: Record<AnswerModel, { backend: string; model: string }> = {
  'gpt-4o': { backend: 'openrouter', model: 'openai/gpt-4o' },
  'sonnet': { backend: 'claude', model: 'sonnet' },
};

export const DATASET_URLS: Record<DatasetVariant, string> = {
  s: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json',
  m: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_m_cleaned.json',
  oracle: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json',
};

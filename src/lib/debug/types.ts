/**
 * Debug Session Types
 *
 * Language-independent structured debugging with hypothesis testing.
 * State persisted to .succ/debugs/{sessionId}/.
 */

export type DebugSessionStatus = 'active' | 'resolved' | 'abandoned';
export type HypothesisResult = 'pending' | 'confirmed' | 'refuted';
export type DebugLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'ruby'
  | 'php'
  | 'swift'
  | 'kotlin'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'unknown';

export interface Hypothesis {
  id: number;
  description: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  test: string;
  result: HypothesisResult;
  logs?: string;
  dead_end_id?: number;
}

export interface InstrumentedFile {
  path: string;
  lines: number[];
  original_content?: string;
}

export interface DebugSession {
  id: string;
  status: DebugSessionStatus;
  bug_description: string;
  error_output?: string;
  reproduction_command?: string;
  language: DebugLanguage;
  hypotheses: Hypothesis[];
  instrumented_files: InstrumentedFile[];
  iteration: number;
  max_iterations: number;
  root_cause?: string;
  fix_description?: string;
  files_modified: string[];
  created_at: string;
  updated_at: string;
  resolved_at?: string;
}

export interface DebugSessionIndexEntry {
  id: string;
  status: DebugSessionStatus;
  bug_description: string;
  language: DebugLanguage;
  hypothesis_count: number;
  iteration: number;
  created_at: string;
  updated_at: string;
}

/**
 * Language → log statement template.
 * `{tag}` and `{value}` are replaced at instrumentation time.
 */
export const LOG_TEMPLATES: Record<DebugLanguage, string> = {
  typescript: "console.error('[SUCC_DEBUG] {tag}:', {value});",
  javascript: "console.error('[SUCC_DEBUG] {tag}:', {value});",
  python: "import sys; print(f'[SUCC_DEBUG] {tag}: {{value}}', file=sys.stderr)",
  go: 'fmt.Fprintf(os.Stderr, "[SUCC_DEBUG] {tag}: %v\\n", {value})',
  rust: 'eprintln!("[SUCC_DEBUG] {tag}: {:?}", {value});',
  java: 'System.err.println("[SUCC_DEBUG] {tag}: " + {value});',
  ruby: '$stderr.puts "[SUCC_DEBUG] {tag}: #{{value}}"',
  php: "error_log('[SUCC_DEBUG] {tag}: ' . {value});",
  swift: 'fputs("[SUCC_DEBUG] {tag}: \\({value})\\n", stderr)',
  kotlin: 'System.err.println("[SUCC_DEBUG] {tag}: ${value}")',
  c: 'fprintf(stderr, "[SUCC_DEBUG] {tag}: %s\\n", {value});',
  cpp: 'std::cerr << "[SUCC_DEBUG] {tag}: " << {value} << std::endl;',
  csharp: 'Console.Error.WriteLine($"[SUCC_DEBUG] {tag}: {{value}}");',
  unknown: '// [SUCC_DEBUG] {tag}: {value}',
};

/**
 * File extension → language mapping
 */
export const EXTENSION_MAP: Record<string, DebugLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
};

/**
 * Detect language from file extension
 */
export function detectLanguage(filePath: string): DebugLanguage {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return EXTENSION_MAP[ext] ?? 'unknown';
}

/**
 * Generate a log statement for a specific language
 */
export function generateLogStatement(language: DebugLanguage, tag: string, value: string): string {
  const template = LOG_TEMPLATES[language];
  return template.replace(/\{tag\}/g, tag).replace(/\{value\}/g, value);
}

/**
 * Convert session to index entry
 */
export function sessionToIndexEntry(session: DebugSession): DebugSessionIndexEntry {
  return {
    id: session.id,
    status: session.status,
    bug_description: session.bug_description.substring(0, 200),
    language: session.language,
    hypothesis_count: session.hypotheses.length,
    iteration: session.iteration,
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
}

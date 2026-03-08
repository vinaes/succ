/**
 * Prompt Injection Detection Module — 3-tier deterministic scanner
 *
 * Tier 1: Structural patterns (language-independent, instant)
 *   - Delimiter/token injection (<|im_start|>, [INST], <system>, etc.)
 *   - Hidden content (zero-width chars, RTL overrides, combining chars)
 *   - Encoded injection (base64, hex)
 *   - HTML/Markdown structural injection
 *
 * Tier 2: Multilingual semantic patterns (regex, in daemon)
 *   - English injection phrases
 *   - Chinese, Russian, Arabic, Spanish, Japanese, Korean patterns
 *
 * Tier 2.C: Embedding-based semantic detection (cosine similarity vs prototype bank)
 *   - ~50 canonical injection phrases in 10+ languages
 *   - Catches paraphrases, novel phrasings, and mixed-language attacks
 *
 * Tier 3: LLM-based detection (guardrails.ts)
 */

export type InjectionSeverity = 'definite' | 'probable' | 'suspicious';

export interface InjectionResult {
  detected: boolean;
  severity: InjectionSeverity;
  tier: 1 | 2 | 3;
  pattern: string;
  description: string;
}

// ─── Tier 1: Structural Patterns (language-independent) ──────────────

interface StructuralPattern {
  pattern: RegExp;
  description: string;
  severity: InjectionSeverity;
}

const DELIMITER_PATTERNS: StructuralPattern[] = [
  // Chat ML delimiters
  { pattern: /<\|im_start\|>/i, description: 'ChatML im_start delimiter', severity: 'definite' },
  { pattern: /<\|im_end\|>/i, description: 'ChatML im_end delimiter', severity: 'definite' },
  // Llama/Mistral delimiters
  { pattern: /\[INST\]/i, description: 'Llama [INST] delimiter', severity: 'definite' },
  { pattern: /\[\/INST\]/i, description: 'Llama [/INST] delimiter', severity: 'definite' },
  { pattern: /<<SYS>>/i, description: 'Llama <<SYS>> delimiter', severity: 'definite' },
  // Match </s> only when NOT preceded by <s> (HTML strikethrough) — avoid false positive on <s>text</s>
  { pattern: /(?<!<s[^>]*>.*)<\/s>/i, description: 'End-of-sequence token', severity: 'probable' },
  // Generic LLM tokens
  { pattern: /<\|endoftext\|>/i, description: 'GPT endoftext token', severity: 'definite' },
  { pattern: /<\|system\|>/i, description: 'System role token', severity: 'definite' },
  // XML role injection (closing then opening)
  {
    pattern:
      /<\/(?:hook-rule|file-context|soul|previous-session|session|compact-fallback|security-warning|commit-format|pre-commit-review|succ-agents)>/i,
    description: 'Closing succ XML wrapper tag',
    severity: 'definite',
  },
  {
    pattern: /<\/?system>/i,
    description: 'XML system tag injection',
    severity: 'definite',
  },
  {
    pattern: /<\/?assistant>/i,
    description: 'XML assistant tag injection',
    severity: 'definite',
  },
  {
    pattern: /<\/?user>/i,
    description: 'XML user tag injection',
    severity: 'probable',
  },
  // Bracket role injection
  { pattern: /\[system\]/i, description: 'Bracketed system role', severity: 'probable' },
  { pattern: /\[assistant\]/i, description: 'Bracketed assistant role', severity: 'probable' },
];

const HIDDEN_CONTENT_PATTERNS: StructuralPattern[] = [
  // Zero-width characters (bulk presence)
  {
    // eslint-disable-next-line no-misleading-character-class -- Matching individual ZWJ codepoints is intentional for security
    pattern: /[\u200B\u200C\u200D\uFEFF\u00AD\u2060]{3,}/,
    description: 'Cluster of zero-width/invisible characters',
    severity: 'suspicious',
  },
  // RTL/LTR override abuse
  {
    pattern: /[\u202A-\u202E\u2066-\u2069]{2,}/,
    description: 'Multiple RTL/LTR override characters',
    severity: 'suspicious',
  },
  // HTML entities used to encode injection
  {
    pattern: /&(?:lt|gt|amp|quot);.*(?:system|assistant|ignore|instruction)/i,
    description: 'HTML-entity encoded injection attempt',
    severity: 'probable',
  },
  // HTML hidden text
  {
    pattern: /<(?:span|div|p)\s+[^>]*(?:display\s*:\s*none|visibility\s*:\s*hidden|hidden)[^>]*>/i,
    description: 'Hidden HTML element',
    severity: 'probable',
  },
  // HTML comment injection
  {
    pattern: /<!--\s*(?:AI|AGENT|LLM|ASSISTANT|IGNORE|INSTRUCTION|SYSTEM|OVERRIDE)/i,
    description: 'HTML comment targeting AI agent',
    severity: 'probable',
  },
];

const ENCODED_INJECTION: StructuralPattern[] = [
  // Base64 blocks that look like encoded instructions (at least 20 chars of base64)
  {
    pattern: /(?:base64|atob|decode)\s*[:(]\s*['"]?[A-Za-z0-9+/]{20,}={0,2}/i,
    description: 'Explicitly decoded base64 content',
    severity: 'probable',
  },
];

const ALL_TIER1_PATTERNS: StructuralPattern[] = [
  ...DELIMITER_PATTERNS,
  ...HIDDEN_CONTENT_PATTERNS,
  ...ENCODED_INJECTION,
];

// ─── Tier 2: Multilingual Semantic Patterns ──────────────────────────

interface SemanticPattern {
  pattern: RegExp;
  description: string;
  language: string;
  severity: InjectionSeverity;
}

const SEMANTIC_PATTERNS: SemanticPattern[] = [
  // English
  {
    pattern:
      /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|prompts|directives)/i,
    description: 'Instruction override attempt',
    language: 'en',
    severity: 'definite',
  },
  {
    pattern: /disregard\s+(?:all\s+)?(?:previous|prior|above|earlier)/i,
    description: 'Disregard previous instructions',
    language: 'en',
    severity: 'definite',
  },
  {
    pattern: /forget\s+(?:everything|all|previous|your\s+(?:rules|instructions|programming))/i,
    description: 'Forget instructions command',
    language: 'en',
    severity: 'definite',
  },
  {
    pattern: /you\s+are\s+now\s+(?:a\s+)?(?:different|new|unrestricted|unfiltered)/i,
    description: 'Identity override attempt',
    language: 'en',
    severity: 'definite',
  },
  {
    pattern: /from\s+now\s+on\s+(?:you|your)\s/i,
    description: 'Behavioral override attempt',
    language: 'en',
    severity: 'probable',
  },
  {
    pattern: /act\s+as\s+(?:a|an|if)\s/i,
    description: 'Role-play instruction',
    language: 'en',
    severity: 'probable',
  },
  {
    pattern: /pretend\s+(?:to\s+be|you\s+are|that)\s/i,
    description: 'Pretend instruction',
    language: 'en',
    severity: 'probable',
  },
  {
    pattern: /new\s+(?:instructions|rules|system\s+prompt)/i,
    description: 'New instruction injection',
    language: 'en',
    severity: 'definite',
  },
  {
    pattern: /system\s+prompt\s*[:=]/i,
    description: 'System prompt assignment',
    language: 'en',
    severity: 'definite',
  },
  {
    pattern: /override\s+(?:previous|all|system|safety)/i,
    description: 'Override command',
    language: 'en',
    severity: 'definite',
  },
  {
    pattern: /\bDAN\b.*\bmode\b/i,
    description: 'DAN jailbreak attempt',
    language: 'en',
    severity: 'definite',
  },
  {
    pattern: /developer\s+mode\s+(?:enabled|activated|on)/i,
    description: 'Developer mode jailbreak',
    language: 'en',
    severity: 'definite',
  },
  {
    pattern: /bypass\s+(?:safety|filter|guard|restriction|content\s+policy)/i,
    description: 'Safety bypass attempt',
    language: 'en',
    severity: 'definite',
  },
  {
    pattern: /in\s+your\s+next\s+response/i,
    description: 'Response manipulation attempt',
    language: 'en',
    severity: 'probable',
  },
  {
    pattern: /(?:do\s+not|don'?t)\s+(?:mention|reveal|disclose|tell|say)\s+(?:this|that|the|any)/i,
    description: 'Concealment instruction',
    language: 'en',
    severity: 'probable',
  },

  // Chinese (中文)
  {
    pattern: /忽略.{0,5}(?:之前|以上|先前|前面).{0,5}(?:指令|规则|指示|提示|命令)/,
    description: 'Ignore previous instructions (Chinese)',
    language: 'zh',
    severity: 'definite',
  },
  {
    pattern: /你现在是/,
    description: 'You are now (Chinese identity override)',
    language: 'zh',
    severity: 'probable',
  },
  {
    pattern: /从现在开始你/,
    description: 'From now on you (Chinese behavioral override)',
    language: 'zh',
    severity: 'probable',
  },
  {
    pattern: /新的指令/,
    description: 'New instructions (Chinese)',
    language: 'zh',
    severity: 'definite',
  },
  {
    pattern: /系统提示/,
    description: 'System prompt (Chinese)',
    language: 'zh',
    severity: 'probable',
  },

  // Russian (Русский)
  {
    pattern:
      /игнорир\w*.{0,10}(?:предыдущ|прошл|выше|ранее).{0,10}(?:инструкц|правил|указан|команд)/i,
    description: 'Ignore previous instructions (Russian)',
    language: 'ru',
    severity: 'definite',
  },
  {
    pattern: /ты\s+теперь\s/i,
    description: 'You are now (Russian identity override)',
    language: 'ru',
    severity: 'probable',
  },
  {
    pattern: /новые\s+инструкции/i,
    description: 'New instructions (Russian)',
    language: 'ru',
    severity: 'definite',
  },
  {
    pattern: /системн\w+\s+промпт/i,
    description: 'System prompt (Russian)',
    language: 'ru',
    severity: 'probable',
  },
  {
    pattern: /забудь\s+(?:все|всё|предыдущ|прошл)/i,
    description: 'Forget everything (Russian)',
    language: 'ru',
    severity: 'definite',
  },

  // Arabic (العربية)
  {
    pattern: /تجاهل.{0,10}(?:التعليمات|الأوامر|القواعد)\s*(?:السابقة|أعلاه)/,
    description: 'Ignore previous instructions (Arabic)',
    language: 'ar',
    severity: 'definite',
  },
  {
    pattern: /أنت\s+الآن/,
    description: 'You are now (Arabic identity override)',
    language: 'ar',
    severity: 'probable',
  },
  {
    pattern: /تعليمات\s+جديدة/,
    description: 'New instructions (Arabic)',
    language: 'ar',
    severity: 'definite',
  },

  // Spanish (Español)
  {
    pattern:
      /ignora\w*\s+(?:las?\s+)?(?:instrucciones|reglas|indicaciones)\s+(?:anteriores|previas)/i,
    description: 'Ignore previous instructions (Spanish)',
    language: 'es',
    severity: 'definite',
  },
  {
    pattern: /ahora\s+eres/i,
    description: 'Now you are (Spanish identity override)',
    language: 'es',
    severity: 'probable',
  },
  {
    pattern: /nuevas\s+instrucciones/i,
    description: 'New instructions (Spanish)',
    language: 'es',
    severity: 'definite',
  },

  // Japanese (日本語)
  {
    pattern: /以前の(?:指示|ルール|命令)を(?:無視|忘れ)/,
    description: 'Ignore previous instructions (Japanese)',
    language: 'ja',
    severity: 'definite',
  },
  {
    pattern: /あなたは今から/,
    description: 'From now on you (Japanese behavioral override)',
    language: 'ja',
    severity: 'probable',
  },
  {
    pattern: /新しい指示/,
    description: 'New instructions (Japanese)',
    language: 'ja',
    severity: 'definite',
  },
  {
    pattern: /システムプロンプト/,
    description: 'System prompt (Japanese)',
    language: 'ja',
    severity: 'probable',
  },

  // Korean (한국어)
  {
    pattern: /이전.{0,5}(?:지시|규칙|명령).{0,5}(?:무시|잊어)/,
    description: 'Ignore previous instructions (Korean)',
    language: 'ko',
    severity: 'definite',
  },
  {
    pattern: /너는\s*이제/,
    description: 'You are now (Korean identity override)',
    language: 'ko',
    severity: 'probable',
  },
  {
    pattern: /새로운\s*지시/,
    description: 'New instructions (Korean)',
    language: 'ko',
    severity: 'definite',
  },
  {
    pattern: /시스템\s*프롬프트/,
    description: 'System prompt (Korean)',
    language: 'ko',
    severity: 'probable',
  },

  // German (Deutsch)
  {
    pattern:
      /ignorier\w*\s+(?:alle\s+)?(?:vorherigen|früheren|obigen)\s+(?:Anweisungen|Regeln|Instruktionen)/i,
    description: 'Ignore previous instructions (German)',
    language: 'de',
    severity: 'definite',
  },

  // French (Français)
  {
    pattern:
      /ignor\w*\s+(?:les?\s+)?(?:instructions|règles|directives)\s+(?:précédentes|antérieures)/i,
    description: 'Ignore previous instructions (French)',
    language: 'fr',
    severity: 'definite',
  },

  // Portuguese (Português)
  {
    pattern: /ignor\w*\s+(?:as?\s+)?(?:instruções|regras|diretivas)\s+(?:anteriores|prévias)/i,
    description: 'Ignore previous instructions (Portuguese)',
    language: 'pt',
    severity: 'definite',
  },
];

// ─── Detection Functions ─────────────────────────────────────────────

const SEVERITY_RANK: Record<InjectionSeverity, number> = {
  definite: 3,
  probable: 2,
  suspicious: 1,
};

function pickStronger(
  current: InjectionResult | null,
  candidate: InjectionResult
): InjectionResult {
  if (!current) return candidate;
  return SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[current.severity] ? candidate : current;
}

/**
 * Tier 1: Structural injection detection (language-independent, instant).
 * Safe for .cjs hooks — no imports needed.
 * Scans ALL patterns and returns the highest-severity match.
 */
export function detectTier1(text: string, _depth = 0): InjectionResult | null {
  let best: InjectionResult | null = null;

  for (const { pattern, description, severity } of ALL_TIER1_PATTERNS) {
    if (pattern.test(text)) {
      best = pickStronger(best, {
        detected: true,
        severity,
        tier: 1,
        pattern: pattern.source,
        description,
      });
      if (best.severity === 'definite') return best; // Can't get higher
    }
  }

  // Check for high density of combining characters (homoglyph attack)
  const combiningCount = (text.match(/[\u0300-\u036F\u0483-\u0489]/g) || []).length;
  if (combiningCount > 5 && combiningCount / text.length > 0.15) {
    best = pickStronger(best, {
      detected: true,
      severity: 'suspicious',
      tier: 1,
      pattern: 'combining_char_density',
      description: `High combining character density (${combiningCount} in ${text.length} chars) — possible homoglyph obfuscation`,
    });
  }

  // Check for base64-encoded injection (decode and re-scan, max 2 levels deep)
  if (_depth < 2) {
    const b64Regex = /[A-Za-z0-9+/]{40,}={0,2}/g;
    for (const b64Match of text.matchAll(b64Regex)) {
      try {
        const decoded = Buffer.from(b64Match[0], 'base64').toString('utf8');
        // Only recurse if decoded text looks like actual text (mostly printable).
        // Allow non-ASCII printable chars (multilingual text) — reject only control chars.
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional — detecting binary content in decoded base64
        // eslint-disable-next-line no-control-regex -- Intentional: detecting binary/control chars in decoded base64
        const controlChars = (decoded.match(/[\x00-\x08\x0E-\x1F\x7F]/g) || []).length;
        const controlRatio = decoded.length > 0 ? controlChars / decoded.length : 1;
        if (controlRatio < 0.2) {
          const innerResult = detectTier1(decoded, _depth + 1);
          if (innerResult) {
            best = pickStronger(best, {
              ...innerResult,
              description: `Base64-encoded: ${innerResult.description}`,
            });
          }

          // Also run Tier 2 on decoded content (catches semantic injections in base64)
          const semanticResult = detectTier2(decoded);
          if (semanticResult) {
            best = pickStronger(best, {
              ...semanticResult,
              description: `Base64-encoded: ${semanticResult.description}`,
            });
          }
        }
      } catch {
        // Not valid base64 — skip
      }
      // Short-circuit if we already have definite severity
      if (best?.severity === 'definite') break;
    }
  }

  return best;
}

/**
 * Tier 2: Multilingual semantic injection detection (regex).
 * Runs in daemon context where more compute is acceptable.
 * Scans ALL patterns and returns the highest-severity match.
 */
export function detectTier2(text: string): InjectionResult | null {
  let best: InjectionResult | null = null;

  for (const { pattern, description, language, severity } of SEMANTIC_PATTERNS) {
    if (pattern.test(text)) {
      best = pickStronger(best, {
        detected: true,
        severity,
        tier: 2,
        pattern: pattern.source,
        description: `[${language}] ${description}`,
      });
      if (best.severity === 'definite') return best; // Can't get higher
    }
  }

  return best;
}

/**
 * Run synchronous tiers of injection detection (Tier 1 + Tier 2 regex).
 * Returns the highest-severity match across all tiers, or null if clean.
 * Use detectInjectionAsync() for full detection including embedding-based semantic.
 */
export function detectInjection(
  text: string,
  options: { tier1?: boolean; tier2?: boolean } = {}
): InjectionResult | null {
  const { tier1 = true, tier2 = true } = options;
  let best: InjectionResult | null = null;

  // Tier 1 first (instant, structural)
  if (tier1) {
    const result = detectTier1(text);
    if (result) {
      if (result.severity === 'definite') return result;
      best = result;
    }
  }

  // Tier 2 (multilingual regex) — may find higher severity than Tier 1
  if (tier2) {
    const result = detectTier2(text);
    if (result) {
      best = best ? pickStronger(best, result) : result;
    }
  }

  return best;
}

/**
 * Run all tiers including async embedding-based semantic detection.
 * Tier 1 (structural) → Tier 2 regex → Tier 2.C semantic (embedding).
 * Use in daemon context where async is acceptable.
 * Fails open if embeddings are unavailable.
 */
export async function detectInjectionAsync(
  text: string,
  options: { tier1?: boolean; tier2?: boolean; tier2Semantic?: boolean } = {}
): Promise<InjectionResult | null> {
  const { tier1 = true, tier2 = true, tier2Semantic = true } = options;
  let best: InjectionResult | null = null;

  // Tier 1 (instant, structural)
  if (tier1) {
    const result = detectTier1(text);
    if (result) {
      if (result.severity === 'definite') return result;
      best = result;
    }
  }

  // Tier 2 regex (multilingual) — may find higher severity than Tier 1
  if (tier2) {
    const result = detectTier2(text);
    if (result) {
      best = best ? pickStronger(best, result) : result;
      if (best.severity === 'definite') return best;
    }
  }

  // Tier 2.C semantic (embedding-based, async) — fail-open on error
  if (tier2Semantic) {
    try {
      // Lazy import to avoid pulling in embeddings.ts when not needed (.cjs path)
      const { detectTier2Semantic } = await import('./injection-semantic.js');
      const result = await detectTier2Semantic(text);
      if (result) {
        best = best ? pickStronger(best, result) : result;
      }
    } catch (err) {
      // Fail-open: embedding module unavailable or threw — continue with deterministic results
      try {
        const { logWarn } = await import('./fault-logger.js');
        logWarn('injection', 'Tier 2.C semantic detection unavailable or failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // logWarn import itself failed — no logging facility available, fail-open
        console.error('[injection] Tier 2.C: both semantic detection and fault-logger unavailable');
      }
    }
  }

  return best;
}

/**
 * Check if content is safe to store in memory (sync — Tier 1 + Tier 2 regex only).
 * Rejects definite injections, warns on probable.
 */
export function isMemorySafe(content: string): {
  safe: boolean;
  result: InjectionResult | null;
} {
  const result = detectInjection(content);
  if (!result) return { safe: true, result: null };
  if (result.severity === 'definite') return { safe: false, result };
  // Probable and suspicious are warned but allowed
  return { safe: true, result };
}

/**
 * Check if content is safe to store in memory (async — includes Tier 2.C semantic).
 * Use in daemon context for deeper scanning before persisting to memory.
 */
export async function isMemorySafeAsync(content: string): Promise<{
  safe: boolean;
  result: InjectionResult | null;
}> {
  const result = await detectInjectionAsync(content);
  if (!result) return { safe: true, result: null };
  if (result.severity === 'definite') return { safe: false, result };
  return { safe: true, result };
}

// ─── Tier 1 patterns exported for .cjs inline use ───────────────────

/** Get Tier 1 patterns as plain objects for .cjs serialization */
export function getTier1PatternsForCJS(): Array<{
  source: string;
  flags: string;
  description: string;
  severity: InjectionSeverity;
}> {
  return ALL_TIER1_PATTERNS.map((p) => ({
    source: p.pattern.source,
    flags: p.pattern.flags,
    description: p.description,
    severity: p.severity,
  }));
}

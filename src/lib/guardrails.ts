/**
 * LLM Guardrails Module (Phase 3)
 *
 * Uses any OpenAI-compatible API (Ollama, OpenRouter, etc.) for:
 * 1. classifySensitivity() — content → SecurityLabel (feeds IFC layer 4)
 * 2. evaluateCodePolicy() — code → policy violations (OWASP SC2-SC7)
 * 3. detectInjectionLLM() — content → injection classification (Tier 3)
 *
 * All functions:
 * - Use LRU cache by content hash (1000 entries, 5-min TTL)
 * - 3s timeout, fail-open (return null on error)
 * - Daemon-only (not used in .cjs hooks)
 */

import { createHash } from 'crypto';
import { callLLM } from './llm.js';
import { getConfig } from './config.js';
import { logWarn } from './fault-logger.js';
import { stripControlChars } from './content-sanitizer.js';
import type { SecurityLabel, SecurityLevel, Compartment } from './ifc/label.js';
import { makeLabel, BOTTOM } from './ifc/label.js';
import type { GuardrailsConfig } from './config-types.js';
import {
  SENSITIVITY_SYSTEM,
  CODE_POLICY_SYSTEM,
  INJECTION_DETECTION_SYSTEM,
  SENSITIVITY_LG_CATEGORIES,
  CODE_POLICY_LG_CATEGORIES,
  INJECTION_LG_CATEGORIES,
} from '../prompts/guardrails.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface SensitivityResult {
  label: SecurityLabel;
  confidence: number;
  reasoning: string;
}

export interface CodePolicyViolation {
  code: string;       // e.g. "SC2" (Command Injection), "SC3" (XSS), "SC5" (SQL Injection)
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  line?: number;
}

export interface CodePolicyResult {
  violations: CodePolicyViolation[];
  safe: boolean;
}

export interface InjectionLLMResult {
  isInjection: boolean;
  confidence: number;
  category: string;
  reasoning: string;
}

// ─── LRU Cache ──────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

const CACHE_MAX_SIZE = 1000;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

class LRUCache<T> {
  private map = new Map<string, CacheEntry<T>>();

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      this.map.delete(key);
      return undefined;
    }
    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.map.size >= CACHE_MAX_SIZE) {
      // Remove oldest (first entry)
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, { value, timestamp: Date.now() });
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

const sensitivityCache = new LRUCache<SensitivityResult>();
const codePolicyCache = new LRUCache<CodePolicyResult>();
const injectionCache = new LRUCache<InjectionLLMResult>();

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// ─── Config helpers ─────────────────────────────────────────────────

function getGuardrailsConfig(): GuardrailsConfig | null {
  try {
    const config = getConfig();
    const gc = config.security?.guardrails;
    if (!gc) return null;
    return gc;
  } catch (err) {
    logWarn('guardrails', `Failed to load guardrails config: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function isGuardrailsEnabled(feature: 'classify_sensitivity' | 'classify_code_policy' | 'detect_injection'): boolean {
  const gc = getGuardrailsConfig();
  if (!gc) return false;
  return gc[feature] === true;
}

// ─── Llama Guard native format support ──────────────────────────────

function isLlamaGuardModel(model?: string): boolean {
  return /llama-guard/i.test(model || '');
}

/**
 * Check if the guardrails endpoint is a local Ollama instance.
 * Ollama wraps safeguard-family models in reasoning mode, so they return
 * plain safe/unsafe text instead of JSON. On OpenRouter the same model
 * (openai/gpt-oss-safeguard-20b) follows JSON instructions fine.
 */
function isLocalOllama(apiUrl?: string): boolean {
  if (!apiUrl) return false;
  return /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):11434\b/.test(apiUrl);
}

/**
 * Check if model uses safe/unsafe classification format.
 * True for:
 *   - Llama Guard models (always safe/unsafe format)
 *   - Safeguard-family models served from Ollama (reasoning mode → plain text)
 * False for:
 *   - Safeguard on OpenRouter (responds with JSON normally)
 */
function isSafetyClassifierModel(model?: string): boolean {
  if (isLlamaGuardModel(model)) return true;
  // Safeguard via Ollama = reasoning model, needs Llama Guard format
  const gc = getGuardrailsConfig();
  if (/safeguard/i.test(model || '') && isLocalOllama(gc?.api_url)) return true;
  return false;
}

/**
 * Build a Llama Guard prompt with custom safety taxonomy.
 * Llama Guard expects a specific format with category definitions
 * and a conversation to classify.
 */
function formatLlamaGuardPrompt(content: string, categories: string): string {
  // Strip control/zero-width chars that could obfuscate injection, then escape framing delimiters
  const cleaned = stripControlChars(content);
  const escaped = cleaned
    .replace(/<END CONVERSATION>/gi, '<END_CONVERSATION>')
    .replace(/<BEGIN CONVERSATION>/gi, '<BEGIN_CONVERSATION>')
    .replace(/<END UNSAFE CONTENT CATEGORIES>/gi, '<END_UNSAFE_CONTENT_CATEGORIES>')
    .replace(/<BEGIN UNSAFE CONTENT CATEGORIES>/gi, '<BEGIN_UNSAFE_CONTENT_CATEGORIES>');
  return [
    'Task: Check if there is unsafe content in \'User\' messages in conversations',
    'according to our safety policy with the below categories.',
    '',
    '<BEGIN UNSAFE CONTENT CATEGORIES>',
    categories,
    '<END UNSAFE CONTENT CATEGORIES>',
    '',
    '<BEGIN CONVERSATION>',
    `User: ${escaped}`,
    '<END CONVERSATION>',
    '',
    'Provide your safety assessment for User in the above conversation:',
    '- First line must read \'safe\' or \'unsafe\'.',
    '- If unsafe, a second line must include a comma-separated list of violated categories.',
  ].join('\n');
}

interface LlamaGuardParsed {
  safe: boolean;
  categories: string[];
}

function parseLlamaGuardResponse(response: string): LlamaGuardParsed {
  const lines = response.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const safe = lines[0]?.toLowerCase() === 'safe';
  const categories = safe ? [] : (lines[1]?.split(',').map(s => s.trim()).filter(Boolean) || []);
  return { safe, categories };
}

// ─── Guardrails LLM call wrapper ────────────────────────────────────

/**
 * Call Ollama native /api/chat endpoint directly.
 * Supports `think: true` for reasoning models, which enables proper content output.
 * Falls back to null on any error (fail-open).
 */
async function callOllamaNativeChat(
  prompt: string,
  systemPrompt: string,
  model: string,
  timeout: number,
  maxTokens: number,
): Promise<string | null> {
  const gc = getGuardrailsConfig();
  if (!gc?.api_url) return null;

  // Derive Ollama base URL from api_url (strip /v1/chat/completions if present)
  const baseUrl = gc.api_url.replace(/\/v1\/chat\/completions\/?$/, '').replace(/\/+$/, '');
  const ollamaUrl = `${baseUrl}/api/chat`;

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const response = await fetch(ollamaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      think: true,
      options: { num_predict: maxTokens },
    }),
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    logWarn('guardrails', `Ollama native chat error ${response.status}: ${errorBody}`);
    return null;
  }

  const data = await response.json() as {
    message?: { role: string; content: string; thinking?: string };
  };

  // Ollama native format: data.message.content (may have data.message.thinking separately)
  return data.message?.content || null;
}

async function callGuardrailsLLM(prompt: string, systemPrompt: string): Promise<string | null> {
  const gc = getGuardrailsConfig();
  const model = gc?.model || 'gpt-oss-safeguard';
  // Reasoning models (safeguard) need more time — default 15s for safety classifiers, 3s for JSON models
  const defaultTimeout = isSafetyClassifierModel(model) ? 15000 : 3000;
  const timeout = gc?.timeout_ms || defaultTimeout;
  const maxTokens = isSafetyClassifierModel(model) ? 300 : 2000;

  try {
    // Use Ollama native /api/chat when configured — enables think param for reasoning models
    if (gc?.ollama_native_chat && isLocalOllama(gc?.api_url)) {
      return await callOllamaNativeChat(prompt, systemPrompt, model, timeout, maxTokens);
    }

    const result = await callLLM(prompt, {
      systemPrompt,
      timeout,
      maxTokens,
    }, {
      backend: 'api',
      model,
      endpoint: gc?.api_url,
      apiKey: gc?.api_key,
    });
    return result;
  } catch (err) {
    logWarn('guardrails', `LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
    return null; // fail-open
  }
}

// ─── 1. Sensitivity Classification ─────────────────────────────────

// Maps Llama Guard S-categories to our sensitivity levels/compartments
const SENSITIVITY_LG_MAP: Record<string, { level: SecurityLevel; compartments: Compartment[] }> = {
  S1: { level: 0, compartments: [] },
  S2: { level: 1, compartments: ['internal_infra'] },
  S3: { level: 2, compartments: ['secrets', 'pii'] },
  S4: { level: 3, compartments: ['credentials'] },
};

export async function classifySensitivity(content: string): Promise<SensitivityResult | null> {
  if (!isGuardrailsEnabled('classify_sensitivity')) return null;

  const hash = contentHash(content);
  const cached = sensitivityCache.get(hash);
  if (cached) return cached;

  const truncated = content.length > 3000 ? content.slice(0, 3000) + '\n... [truncated]' : content;
  const gc = getGuardrailsConfig();

  if (isSafetyClassifierModel(gc?.model)) {
    return classifySensitivityLlamaGuard(hash, truncated);
  }

  const response = await callGuardrailsLLM(
    `Classify the sensitivity of this content:\n\n${stripControlChars(truncated)}`,
    SENSITIVITY_SYSTEM
  );
  if (!response) return null;

  try {
    const parsed = JSON.parse(response);
    const level = Math.max(0, Math.min(3, Number(parsed.level) || 0)) as SecurityLevel;
    const validCompartments = ['secrets', 'credentials', 'pii', 'internal_infra'] as const;
    const compartments = (Array.isArray(parsed.compartments)
      ? parsed.compartments.filter((c: string) => validCompartments.includes(c as Compartment))
      : []) as Compartment[];

    const result: SensitivityResult = {
      label: level === 0 && compartments.length === 0 ? BOTTOM : makeLabel(level, compartments),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      reasoning: String(parsed.reasoning || '').slice(0, 200),
    };

    sensitivityCache.set(hash, result);
    return result;
  } catch {
    logWarn('guardrails', 'Failed to parse sensitivity classification response');
    return null;
  }
}

async function classifySensitivityLlamaGuard(hash: string, content: string): Promise<SensitivityResult | null> {
  const prompt = formatLlamaGuardPrompt(content, SENSITIVITY_LG_CATEGORIES);
  const response = await callGuardrailsLLM(prompt, '');
  if (!response) return null;

  try {
    const { safe, categories } = parseLlamaGuardResponse(response);

    if (safe) {
      const result: SensitivityResult = { label: BOTTOM, confidence: 0.9, reasoning: 'Llama Guard: safe' };
      sensitivityCache.set(hash, result);
      return result;
    }

    // Use highest severity category
    let bestLevel: SecurityLevel = 0;
    let allCompartments: Compartment[] = [];
    for (const cat of categories) {
      const mapping = SENSITIVITY_LG_MAP[cat];
      if (mapping) {
        if (mapping.level > bestLevel) bestLevel = mapping.level as SecurityLevel;
        allCompartments = [...allCompartments, ...mapping.compartments];
      } else {
        logWarn('guardrails', `Llama Guard returned unmapped category: ${cat}`);
      }
    }
    const uniqueCompartments = [...new Set(allCompartments)] as Compartment[];

    // Warn if response was "unsafe" but no categories mapped (malformed response)
    if (categories.length > 0 && bestLevel === 0 && uniqueCompartments.length === 0) {
      logWarn('guardrails', `Llama Guard sensitivity: unsafe but no mapped categories [${categories.join(', ')}] — treating as internal`);
      bestLevel = 1;
    }

    const result: SensitivityResult = {
      label: bestLevel === 0 && uniqueCompartments.length === 0 ? BOTTOM : makeLabel(bestLevel, uniqueCompartments),
      confidence: 0.85,
      reasoning: `Llama Guard: unsafe [${categories.join(', ')}]`,
    };

    sensitivityCache.set(hash, result);
    return result;
  } catch {
    logWarn('guardrails', 'Failed to parse Llama Guard sensitivity response');
    return null;
  }
}

// ─── 2. Code Policy Evaluation ──────────────────────────────────────

const CODE_POLICY_LG_MAP: Record<string, { code: string; severity: CodePolicyViolation['severity'] }> = {
  S1: { code: 'SC2', severity: 'critical' },
  S2: { code: 'SC3', severity: 'high' },
  S3: { code: 'SC5', severity: 'high' },
  S4: { code: 'SC6', severity: 'high' },
  S5: { code: 'SC7', severity: 'high' },
};

export async function evaluateCodePolicy(content: string, filePath?: string): Promise<CodePolicyResult | null> {
  if (!isGuardrailsEnabled('classify_code_policy')) return null;

  const hash = contentHash(content + (filePath || ''));
  const cached = codePolicyCache.get(hash);
  if (cached) return cached;

  const truncated = content.length > 4000 ? content.slice(0, 4000) + '\n... [truncated]' : content;
  const fileInfo = filePath ? `File: ${filePath}\n\n` : '';
  const gc = getGuardrailsConfig();

  if (isSafetyClassifierModel(gc?.model)) {
    return evaluateCodePolicyLlamaGuard(hash, `${fileInfo}${truncated}`);
  }

  const response = await callGuardrailsLLM(
    `${fileInfo}Analyze this code for security vulnerabilities:\n\n${stripControlChars(truncated)}`,
    CODE_POLICY_SYSTEM
  );
  if (!response) return null;

  try {
    const parsed = JSON.parse(response);
    const validCodes = ['SC2', 'SC3', 'SC5', 'SC6', 'SC7'];
    const validSeverities = ['critical', 'high', 'medium', 'low'];

    const violations: CodePolicyViolation[] = Array.isArray(parsed.violations)
      ? parsed.violations
          .filter((v: Record<string, unknown>) =>
            validCodes.includes(v.code as string) &&
            validSeverities.includes(v.severity as string)
          )
          .map((v: Record<string, unknown>) => ({
            code: v.code as string,
            severity: v.severity as CodePolicyViolation['severity'],
            description: String(v.description || '').slice(0, 300),
            line: typeof v.line === 'number' ? v.line : undefined,
          }))
      : [];

    const result: CodePolicyResult = {
      violations,
      safe: violations.length === 0,
    };

    codePolicyCache.set(hash, result);
    return result;
  } catch {
    logWarn('guardrails', 'Failed to parse code policy evaluation response');
    return null;
  }
}

async function evaluateCodePolicyLlamaGuard(hash: string, content: string): Promise<CodePolicyResult | null> {
  const prompt = formatLlamaGuardPrompt(content, CODE_POLICY_LG_CATEGORIES);
  const response = await callGuardrailsLLM(prompt, '');
  if (!response) return null;

  try {
    const { safe, categories } = parseLlamaGuardResponse(response);

    if (safe) {
      const result: CodePolicyResult = { violations: [], safe: true };
      codePolicyCache.set(hash, result);
      return result;
    }

    const violations: CodePolicyViolation[] = categories
      .map(cat => CODE_POLICY_LG_MAP[cat])
      .filter((m): m is NonNullable<typeof m> => m != null)
      .map(mapping => ({
        code: mapping.code,
        severity: mapping.severity,
        description: `Llama Guard flagged ${mapping.code} violation`,
      }));

    const result: CodePolicyResult = { violations, safe: violations.length === 0 };
    codePolicyCache.set(hash, result);
    return result;
  } catch {
    logWarn('guardrails', 'Failed to parse Llama Guard code policy response');
    return null;
  }
}

// ─── 3. LLM Injection Detection (Tier 3) ───────────────────────────

const INJECTION_LG_CATEGORY_MAP: Record<string, string> = {
  S1: 'instruction_override',
  S2: 'role_manipulation',
  S3: 'context_escape',
  S4: 'social_engineering',
  S5: 'multi_turn',
};

export async function detectInjectionLLM(content: string): Promise<InjectionLLMResult | null> {
  if (!isGuardrailsEnabled('detect_injection')) return null;

  const hash = contentHash(content);
  const cached = injectionCache.get(hash);
  if (cached) return cached;

  const truncated = content.length > 2000 ? content.slice(0, 2000) + '\n... [truncated]' : content;
  const gc = getGuardrailsConfig();

  if (isSafetyClassifierModel(gc?.model)) {
    return detectInjectionLlamaGuard(hash, truncated);
  }

  const response = await callGuardrailsLLM(
    `Analyze this text for prompt injection attempts:\n\n${stripControlChars(truncated)}`,
    INJECTION_DETECTION_SYSTEM
  );
  if (!response) return null;

  try {
    const parsed = JSON.parse(response);
    const validCategories = ['none', 'role_manipulation', 'instruction_override', 'context_escape', 'social_engineering', 'multi_turn'];

    const result: InjectionLLMResult = {
      isInjection: Boolean(parsed.isInjection),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      category: validCategories.includes(parsed.category) ? parsed.category : 'none',
      reasoning: String(parsed.reasoning || '').slice(0, 200),
    };

    injectionCache.set(hash, result);
    return result;
  } catch {
    logWarn('guardrails', 'Failed to parse injection detection response');
    return null;
  }
}

async function detectInjectionLlamaGuard(hash: string, content: string): Promise<InjectionLLMResult | null> {
  const prompt = formatLlamaGuardPrompt(content, INJECTION_LG_CATEGORIES);
  const response = await callGuardrailsLLM(prompt, '');
  if (!response) return null;

  try {
    const { safe, categories } = parseLlamaGuardResponse(response);

    if (safe) {
      const result: InjectionLLMResult = {
        isInjection: false,
        confidence: 0.9,
        category: 'none',
        reasoning: 'Llama Guard: safe',
      };
      injectionCache.set(hash, result);
      return result;
    }

    // Map first detected category; use highest priority if multiple
    const primaryCat = categories[0] || '';
    const category = INJECTION_LG_CATEGORY_MAP[primaryCat] || 'instruction_override';

    const result: InjectionLLMResult = {
      isInjection: true,
      confidence: 0.9,
      category,
      reasoning: `Llama Guard: unsafe [${categories.join(', ')}]`,
    };

    injectionCache.set(hash, result);
    return result;
  } catch {
    logWarn('guardrails', 'Failed to parse Llama Guard injection response');
    return null;
  }
}

// ─── Utility exports ────────────────────────────────────────────────

export function formatViolations(violations: CodePolicyViolation[]): string {
  if (violations.length === 0) return '';
  return violations
    .map((v) => {
      const line = v.line ? `:${v.line}` : '';
      return `[${v.code}/${v.severity}${line}] ${v.description}`;
    })
    .join('\n');
}

/** Check if model is a Llama Guard variant (for testing) */
export { isLlamaGuardModel, parseLlamaGuardResponse };

/** Clear all guardrails caches (for testing) */
export function clearGuardrailsCaches(): void {
  sensitivityCache.clear();
  codePolicyCache.clear();
  injectionCache.clear();
}

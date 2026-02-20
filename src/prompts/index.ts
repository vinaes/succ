/**
 * Centralized Prompt Registry
 *
 * All prompts used in succ are exported from this module.
 * This makes it easy to find, review, and modify prompts.
 *
 * Naming convention:
 *   *_SYSTEM — stable instructions (cached by LLM providers)
 *   *_PROMPT — user template with {placeholders} for dynamic content
 */

// Onboarding prompts
export {
  ONBOARDING_SYSTEM_PROMPT,
  WIZARD_INTRO,
  WIZARD_DISCOVERY_PROJECT,
  WIZARD_DISCOVERY_FRUSTRATION,
  WIZARD_SOLUTION_MAP,
  WIZARD_CONCEPTS_OVERVIEW,
  WIZARD_HANDS_ON_PROMPT,
  WIZARD_CHEATSHEET,
  WIZARD_DONE,
} from './onboarding.js';

// Chat prompts
export { CHAT_SYSTEM_PROMPT } from './chat.js';

// Briefing prompts (compact-briefing, precompute-context)
export {
  BRIEFING_STRUCTURED_SYSTEM,
  BRIEFING_STRUCTURED_PROMPT,
  BRIEFING_PROSE_SYSTEM,
  BRIEFING_PROSE_PROMPT,
  BRIEFING_MINIMAL_SYSTEM,
  BRIEFING_MINIMAL_PROMPT,
  SESSION_BRIEFING_SYSTEM,
  SESSION_BRIEFING_PROMPT,
} from './briefing.js';

// Extraction prompts (session-summary, session-processor)
export {
  FACT_EXTRACTION_SYSTEM,
  FACT_EXTRACTION_PROMPT,
  SESSION_PROGRESS_EXTRACTION_PROMPT,
} from './extraction.js';

// Memory prompts (consolidate)
export { MEMORY_MERGE_SYSTEM, MEMORY_MERGE_PROMPT, TEMPORAL_SUBQUERY_SYSTEM } from './memory.js';

// Skills prompts
export {
  KEYWORD_EXTRACTION_SYSTEM,
  KEYWORD_EXTRACTION_PROMPT,
  SKILL_RANKING_SYSTEM,
  SKILL_RANKING_PROMPT,
} from './skills.js';

// Daemon prompts (service, analyzer)
export {
  REFLECTION_SYSTEM,
  REFLECTION_PROMPT,
  DISCOVERY_SYSTEM,
  DISCOVERY_PROMPT,
} from './daemon.js';

// Analysis prompts (analyze command)
export {
  PROJECT_ANALYSIS_WRAPPER,
  DOCUMENTATION_WRITER_SYSTEM,
  DOCUMENTATION_WRITER_SYSTEM_SHORT,
} from './analyze.js';

// Quality scoring
export { QUALITY_SCORER_SYSTEM } from './quality.js';

// Query expansion prompts
export { EXPANSION_SYSTEM, EXPANSION_PROMPT } from './query-expansion.js';

// Graph relation classification prompts
export { CLASSIFY_SYSTEM, CLASSIFY_PROMPT_SINGLE, CLASSIFY_PROMPT_BATCH } from './graph.js';

// Supersession prompts
export { SUPERSESSION_SYSTEM, SUPERSESSION_PROMPT } from './supersession.js';

// Reflection synthesis prompts
export { SYNTHESIS_SYSTEM, SYNTHESIS_PROMPT } from './synthesis.js';

// PRD pipeline prompts
export {
  PRD_GENERATE_SYSTEM,
  PRD_GENERATE_PROMPT,
  PRD_PARSE_SYSTEM,
  PRD_PARSE_PROMPT,
  TASK_EXECUTION_SYSTEM,
  TASK_EXECUTION_USER_PROMPT,
  TASK_EXECUTION_PROMPT,
} from './prd.js';

// Soul generation prompts
export { SOUL_GENERATION_SYSTEM } from './soul.js';

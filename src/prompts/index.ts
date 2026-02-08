/**
 * Centralized Prompt Registry
 *
 * All prompts used in succ are exported from this module.
 * This makes it easy to find, review, and modify prompts.
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
  BRIEFING_STRUCTURED_PROMPT,
  BRIEFING_PROSE_PROMPT,
  BRIEFING_MINIMAL_PROMPT,
  SESSION_BRIEFING_PROMPT,
} from './briefing.js';

// Extraction prompts (session-summary, session-processor)
export { FACT_EXTRACTION_PROMPT, SESSION_PROGRESS_EXTRACTION_PROMPT } from './extraction.js';

// Memory prompts (consolidate)
export { MEMORY_MERGE_PROMPT } from './memory.js';

// Skills prompts
export { KEYWORD_EXTRACTION_PROMPT, SKILL_RANKING_PROMPT } from './skills.js';

// Daemon prompts (service, analyzer)
export { REFLECTION_PROMPT, DISCOVERY_PROMPT } from './daemon.js';

// Analysis prompts (analyze command)
export {
  PROJECT_ANALYSIS_WRAPPER,
  DOCUMENTATION_WRITER_SYSTEM,
} from './analyze.js';

// Quality scoring
export { QUALITY_SCORER_SYSTEM } from './quality.js';

// PRD pipeline prompts
export { PRD_GENERATE_PROMPT, PRD_PARSE_PROMPT, TASK_EXECUTION_PROMPT } from './prd.js';

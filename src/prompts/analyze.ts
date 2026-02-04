/**
 * Analysis Command Prompts
 *
 * Used by `succ analyze` command for documentation generation.
 */

/**
 * Wrapper for project analysis prompts.
 * Combines project context with agent-specific instructions.
 */
export const PROJECT_ANALYSIS_WRAPPER = `You are analyzing a software project. Here is the project structure and key files:

{context}

---

{agent_prompt}`;

/**
 * System prompt for documentation writer role.
 * Used with local LLM and OpenRouter backends.
 */
export const DOCUMENTATION_WRITER_SYSTEM = `You are an expert software documentation writer. Analyze the provided code and generate high-quality technical documentation in markdown format. Be precise and thorough.`;

/**
 * Shorter system prompt for documentation writer.
 * Used in single-file analysis mode.
 */
export const DOCUMENTATION_WRITER_SYSTEM_SHORT = `You are an expert software documentation writer. Generate clear, concise documentation.`;

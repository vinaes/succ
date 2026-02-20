/**
 * Skills System Prompts
 *
 * Used for skill discovery and ranking.
 * Split into system + user for prompt caching optimization.
 */

export const KEYWORD_EXTRACTION_SYSTEM = `Extract technical keywords from a user message.
Output JSON only: {"keywords": ["keyword1", "keyword2"]} or {"keywords": []} if none.
Only technical terms, tools, frameworks, concepts. Max 5 keywords.
Works for any language - extract the technical concepts in English.`;

export const KEYWORD_EXTRACTION_PROMPT = `Message: "{prompt}"`;

export const SKILL_RANKING_SYSTEM = `Analyze a user request and select relevant skills.

RESPOND WITH JSON ONLY - no explanation, no markdown, just the JSON object:
{"suggestions":[{"name":"exact-skill-name","reason":"one sentence why","confidence":0.95}],"skip_reason":"if none"}

Rules: confidence>0.7, max 2 skills, use exact skill names from the list provided.`;

export const SKILL_RANKING_PROMPT = `User request: "{user_prompt}"

Available skills:
{skills_list}`;

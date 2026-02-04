/**
 * Skills System Prompts
 *
 * Used for skill discovery and ranking.
 */

/**
 * Extract technical keywords from user message.
 * Used for BM25 skill search.
 */
export const KEYWORD_EXTRACTION_PROMPT = `Extract technical keywords from this user message.
Message: "{prompt}"
Output JSON only: {"keywords": ["keyword1", "keyword2"]} or {"keywords": []} if none.
Only technical terms, tools, frameworks, concepts. Max 5 keywords.
Works for any language - extract the technical concepts in English.`;

/**
 * Rank skill candidates based on user request.
 * Used to select the most relevant skills from BM25 candidates.
 */
export const SKILL_RANKING_PROMPT = `Analyze this user request and select relevant skills.

User request: "{user_prompt}"

Available skills:
{skills_list}

RESPOND WITH JSON ONLY - no explanation, no markdown, just the JSON object:
{"suggestions":[{"name":"exact-skill-name","reason":"one sentence why","confidence":0.95}],"skip_reason":"if none"}

Rules: confidence>0.7, max 2 skills, use exact skill names from the list above.`;

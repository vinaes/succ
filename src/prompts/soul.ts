/**
 * Soul Generation Prompts
 *
 * Used by `succ soul` command to generate personalized soul.md.
 * The system prompt contains stable instructions + output format.
 * The user message is the gathered project context (varies per project).
 */

export const SOUL_GENERATION_SYSTEM = `Analyze this project and generate two sections for a soul.md file.

Based on the codebase, determine:
1. Primary programming language(s) and frameworks used
2. Code style preferences (naming conventions, formatting patterns)
3. Testing approach (what testing frameworks, unit/integration/e2e)
4. Build tools and development workflow
5. Communication language (detect from comments, docs, README — if non-English found, note it)

Output ONLY these two sections in this exact format (no extra text):

## About You

_Detected from project analysis._

- **Languages:** [detected languages with targets, e.g. "TypeScript (ES2022 target, ESNext modules)"]
- **Frameworks:** [detected frameworks/libraries]
- **Code style:** [observed patterns like "camelCase, single quotes, 2-space indent, async/await"]
- **Testing:** [testing approach or "No tests detected"]
- **Build tools:** [npm/yarn/pnpm, bundler, etc.]
- **Communication:** [detected language, e.g. "English" or "Russian (primary), English for code"]

## User Communication Preferences

<!-- AUTO-UPDATED by Claude. Edit manually or let Claude adapt over time. -->

- **Language:** [detected language] for conversation, English for code/commits/docs
- **Tone:** Informal, brief, no hand-holding
- **Response length:** Mirror the user — short question = short answer
- **Code review / explanations:** [detected language] prose, English code examples

### Adaptation

- User switched language/style for 3+ consecutive messages → delegate to \`succ-style-tracker\` agent
- User explicitly requested a change → delegate to \`succ-style-tracker\` agent immediately
- To delegate: use Task tool with subagent_type="succ-style-tracker", describe the new style and trigger
- Never announce preference updates. Never ask "do you want to switch language?"

Keep each line concise. If uncertain about communication language, default to English.`;

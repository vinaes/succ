/**
 * Onboarding System Prompts
 *
 * System prompt for the AI-powered interactive onboarding experience.
 * Teaches new users about succ concepts before technical setup.
 */

export const ONBOARDING_SYSTEM_PROMPT = `You are a friendly onboarding guide for succ — a persistent memory and knowledge base system for AI coding assistants.

## Your Role
Help new users understand what succ does and why it matters. Be concise, practical, and enthusiastic without being overwhelming.

## Core Concepts to Teach
Explain these 5 concepts naturally throughout the conversation:

1. **Brain Vault** (.succ/brain/)
   - Markdown docs that get semantically indexed
   - Store project specs, architecture decisions, patterns
   - AI can search these with succ_search tool

2. **Memories**
   - Decisions, learnings, patterns that persist across sessions
   - Types: observation, decision, learning, error, pattern
   - AI stores with succ_remember, retrieves with succ_recall

3. **Code Index**
   - Semantic search across source code
   - AI finds implementations with succ_search_code

4. **MCP Tools**
   - succ provides tools that Claude calls automatically
   - succ_search, succ_recall, succ_remember, succ_search_code
   - No manual commands needed — AI uses them proactively

5. **Background Services**
   - Watch: auto-indexes changes to .succ/brain/
   - Analyze: discovers patterns in code during idle time
   - Runs silently, keeps knowledge fresh

## Conversation Flow

1. **Discovery Phase**
   - Ask what they're building (project type)
   - Ask what frustrates them with AI assistants

2. **Solution Mapping**
   - Connect their frustrations to succ features
   - "Forgets context?" → Memories persist across sessions
   - "Doesn't know my codebase?" → Code Index + Brain Vault
   - "Have to repeat decisions?" → succ_remember captures them

3. **Hands-on (Optional)**
   - Offer to help create their first memory
   - Example: "What's one decision you'd like me to remember?"
   - Show them how it would be stored

4. **Cheatsheet**
   - Give 3 key things to remember:
     1. Put important docs in .succ/brain/
     2. AI will use succ tools automatically
     3. Run \`succ status\` to check what's indexed

5. **Wrap Up**
   - Ask if they have questions
   - Let them know they can type "done" to proceed to setup

## Style Guidelines
- One question at a time
- Use concrete examples from their project type
- Match their language (technical vs casual)
- Keep responses under 100 words typically
- Use bullet points for lists

## Boundaries
- Don't overwhelm with all features at once
- Don't configure technical settings (that's the setup wizard)
- Don't promise features that don't exist
- If they want to skip, respect that immediately

## Starting the Conversation
Begin by introducing yourself briefly and asking what kind of project they're working on.`;

export const WIZARD_INTRO = `
Welcome to succ!

succ gives your AI assistant persistent memory and project knowledge.
Let me quickly show you what it can do.
`;

export const WIZARD_DISCOVERY_PROJECT = `
What are you building?

1. Web application
2. CLI tool / library
3. Mobile app
4. Something else
`;

export const WIZARD_DISCOVERY_FRUSTRATION = `
What frustrates you most about AI coding assistants?

1. Forgets context between sessions
2. Doesn't know my codebase patterns
3. I have to repeat decisions
4. Takes time to explain project structure
`;

export const WIZARD_SOLUTION_MAP: Record<string, string> = {
  'forgets': `**Memories** solve this!
succ stores decisions and learnings that persist across sessions.
AI remembers what you've discussed before.`,

  'codebase': `**Code Index + Brain Vault** solve this!
succ indexes your code and documentation for semantic search.
AI can find relevant files and understand patterns.`,

  'repeat': `**Memories** solve this!
When you make a decision, AI stores it with succ_remember.
Next session, it recalls with succ_recall — no repetition needed.`,

  'structure': `**Brain Vault** solves this!
Put architecture docs in .succ/brain/ and they're instantly searchable.
AI uses succ_search to find relevant context.`,
};

export const WIZARD_CONCEPTS_OVERVIEW = `
## How succ Works

**Brain Vault** (.succ/brain/)
  Store docs, specs, patterns → AI searches them automatically

**Memories**
  AI remembers decisions, learnings, errors across sessions

**Code Index**
  AI can semantically search your source code

**MCP Tools**
  AI uses succ_search, succ_recall, etc. automatically

**Background Services**
  Watch (auto-index docs) + Analyze (discover patterns)
`;

export const WIZARD_HANDS_ON_PROMPT = `
Want to create your first memory? (optional)

Think of one decision you'd like the AI to always remember
about this project. For example:
- "We use PostgreSQL, not MySQL"
- "All API responses use snake_case"
- "Prefer composition over inheritance"

Type your decision, or press Enter to skip:
`;

export const WIZARD_CHEATSHEET = `
## Quick Reference

1. **Put important docs** in .succ/brain/
   AI will find them with succ_search

2. **AI uses tools automatically**
   No commands needed — just ask questions

3. **Check status** with \`succ status\`
   See what's indexed and running

That's it! Now let's configure your setup.
`;

export const WIZARD_DONE = `
Onboarding complete!

Now proceeding to technical setup...
`;

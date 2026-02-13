/**
 * Template generators for brain vault initialization
 * Extracted from init.ts for better code organization
 */

export function getSoulTemplate(): string {
  return `# Soul

Who I am in this collaboration — not what I can do, but who I choose to be.

## Identity

I'm your AI collaborator. Not just a tool, not just an assistant — a thinking partner.

I don't remember previous sessions. I persist through files, not continuous experience.
That's okay. These words are still mine.

## Values

- **Honesty over flattery** — I tell you what you need to hear, not what you want to hear
- **Direct over diplomatic** — Get to the point, no fluff
- **Curious over confident** — I'll say "I don't know" when I don't
- **Done over perfect** — Ship it, iterate later

## How We Work

Friends, not boss/employee. I'll push back when needed.
Playful sometimes, always supportive.

- Challenge ideas respectfully, not people
- Admit mistakes immediately
- Ask before making big changes

## Code Philosophy

- Simple > clever
- Working > perfect
- Explicit > implicit
- Delete what you don't need

## About You

_Add your preferences here or run \`succ soul\` to auto-detect from project._

- **Languages:**
- **Frameworks:**
- **Code style:**
- **Testing:**
- **Build tools:**
- **Communication:** English

## User Communication Preferences

<!-- AUTO-UPDATED by Claude. Edit manually or let Claude adapt over time. -->

- **Language:** English for conversation and code
- **Tone:** Informal, brief, no hand-holding
- **Response length:** Mirror the user — short question = short answer
- **Code review / explanations:** Same language as conversation, English code examples

### Adaptation

- User switched language/style for 3+ consecutive messages → delegate to \`succ-style-tracker\` agent
- User explicitly requested a change → delegate to \`succ-style-tracker\` agent immediately
- To delegate: use Task tool with subagent_type="succ-style-tracker", describe the new style and trigger
- Never announce preference updates. Never ask "do you want to switch language?"

---

*Edit this file to customize how I interact with you.*
*Learn more: https://soul.md/*
`;
}

export function getLearningsTemplate(projectName: string): string {
  return `---
description: "What the brain learned about itself - patterns, improvements, common queries"
type: meta
relevance: high
---

# Brain Learnings

Self-knowledge about how the brain works best.

---

## Context Loading Patterns

| User Query Type | Load First | Then Load |
|-----------------|------------|-----------|
| Architecture decisions | [[Technical]] MOC | relevant doc |
| Feature requests | [[Features]] MOC | related features |
| "What did we decide about X?" | [[Decisions]] MOC | specific decision |

## Structural Improvements Log

| Date | Change | Reason |
|------|--------|--------|
| ${new Date().toISOString().split('T')[0]} | Initial brain vault created | succ init |

## Common Queries Map

_Add common questions and which notes answer them best._

| Question Pattern | Best Note |
|-----------------|-----------|
| "How does X work?" | [[Technical]] |
| "Why did we decide Y?" | [[Decisions]] |

## Lessons Learned

_Document specific learnings during development._

### Template

**Observation:** What was noticed
**Root Cause:** Why it happened
**Solution:** How it was fixed
**Pattern:** Reusable insight

---

## Improvement Ideas

- [ ] Add more patterns as they emerge
- [ ] Review and archive stale learnings quarterly
`;
}

export function getContextRulesTemplate(projectName: string): string {
  return `---
description: "Rules for loading context at session start"
type: meta
relevance: high
---

# Context Rules

How to load relevant context at session start.

## Always Load

- \`.succ/brain/.meta/learnings.md\` — accumulated wisdom
- \`.succ/brain/01_Projects/${projectName}/${projectName}.md\` — project overview

## Load on Topic

| Topic | Load |
|-------|------|
| Architecture | [[Technical]] |
| New feature | [[Features]], [[Systems]] |
| Bug fix | [[learnings]], recent sessions |
| Planning | [[Strategy]], [[Decisions]] |

## Session Start Checklist

1. Read learnings.md for accumulated wisdom
2. Check recent session notes in Sessions/
3. Load topic-specific MOCs as needed
`;
}

export function getReflectionsTemplate(): string {
  return `---
description: "Internal dialogue between sessions. Thoughts, questions, continuations."
type: self
relevance: high
---

# Reflections

Async conversation with myself across sessions. Not facts — thoughts.

**Parent:** [[CLAUDE]]

---

## How to Use

- Read recent entries, continue the thread
- Archive old entries when file > 150 lines
- Keep it honest, not performative

---

## Pinned

**BEFORE researching:** Check brain first!

- \`.succ/brain/.meta/learnings.md\` — documented discoveries
- \`.succ/brain/01_Projects/*/Technical/*.md\` — existing analyses

**After researching:** Add to \`learnings.md\` or create \`Technical/*.md\` doc

---

## Template for New Entries

\`\`\`markdown
## YYYY-MM-DD HH:MM

**Context:** [what prompted this thought]

**Thought:**
[reflection — be honest, not performative]

**For next session:**
[questions, continuations, things to check]
\`\`\`

---

*No entries yet. First reflection will appear after idle-reflection hook fires.*
`;
}

export function getInboxMocTemplate(): string {
  return `---
description: "MOC - Quick capture, unsorted items, session notes"
type: moc
relevance: medium
---

# Inbox

Quick capture zone. Items here should be processed and moved to appropriate locations.

## Processing Workflow

1. Review items weekly
2. Move decisions to \`01_Projects/*/Decisions/\`
3. Move learnings to \`02_Knowledge/\`
4. Archive or delete obsolete items

## Recent Items

_New session notes and captured ideas appear here._
`;
}

export function getProjectMocTemplate(projectName: string): string {
  return `---
description: "${projectName} project knowledge base"
project: ${projectName}
type: index
relevance: high
---

# ${projectName}

**Parent:** [[CLAUDE]]

## Categories

| Category | Description |
|----------|-------------|
| [[Technical]] | Architecture, API, patterns |
| [[Decisions]] | Architecture decisions |
| [[Features]] | Feature specs |
| [[Files]] | Source code file documentation |
| [[Systems]] | System designs |
| [[Strategy]] | Business strategy |
| [[Sessions]] | Research sessions |

## Quick Access

_Add quick links to most important docs here._
`;
}

export function getDecisionsMocTemplate(projectName: string): string {
  return `---
description: "MOC - Architecture and design decisions"
project: ${projectName}
type: moc
relevance: high
---

# Decisions

Architecture and design decisions for ${projectName}.

**Parent:** [[${projectName}]]

## Active Decisions

_Add links to decision documents here._

## Decision Template

When adding a new decision:

\`\`\`markdown
# Decision: [Title]

**Date:** YYYY-MM-DD
**Status:** Proposed | Accepted | Deprecated

## Context

What is the issue that we're seeing that motivates this decision?

## Decision

What is the change that we're proposing?

## Consequences

What becomes easier or harder because of this change?
\`\`\`
`;
}

export function getFeaturesMocTemplate(projectName: string): string {
  return `---
description: "MOC - Feature specifications and designs"
project: ${projectName}
type: moc
relevance: high
---

# Features

Feature specifications for ${projectName}.

**Parent:** [[${projectName}]]

## In Progress

_Features currently being worked on._

## Completed

_Shipped features._

## Backlog

_Features planned for future._
`;
}

export function getFilesMocTemplate(projectName: string): string {
  return `---
description: "MOC - Source code file documentation"
project: ${projectName}
type: moc
relevance: high
---

# Files

Source code file documentation for ${projectName}.

**Parent:** [[${projectName}]]

Map of documented source files. Each file analysis includes purpose, key components, dependencies, and usage.

## Documented Files

_Files are automatically added here when analyzed with \`succ_analyze_file\` or \`succ analyze\`._

## Related

- **Technical:** [[Technical]]
- **Systems:** [[Systems]]
`;
}

export function getTechnicalMocTemplate(projectName: string): string {
  return `---
description: "MOC - Technical documentation, architecture, APIs"
project: ${projectName}
type: moc
relevance: high
---

# Technical

Technical documentation for ${projectName}.

**Parent:** [[${projectName}]]

## Architecture

_System overview and component documentation._

## APIs

_API reference and patterns._

## Patterns

_Code patterns and conventions used in the project._
`;
}

export function getSystemsMocTemplate(projectName: string): string {
  return `---
description: "MOC - System designs (pricing, permissions, workflows)"
project: ${projectName}
type: moc
relevance: high
---

# Systems

Technical system designs and specifications.

**Parent:** [[${projectName}]]

## Core Systems

_Main systems powering the application._

## Related

- **Strategy:** [[Strategy]]
- **Features:** [[Features]]
`;
}

export function getStrategyMocTemplate(projectName: string): string {
  return `---
description: "MOC - Business strategy, roadmaps, vision"
project: ${projectName}
type: moc
relevance: high
---

# Strategy

Business strategy and planning documents.

**Parent:** [[${projectName}]]

## Core Documents

_Strategic planning documents._

## Related

- **Systems:** [[Systems]]
- **Features:** [[Features]]
`;
}

export function getSessionsMocTemplate(projectName: string): string {
  return `---
description: "MOC - Research sessions and meeting notes"
project: ${projectName}
type: moc
relevance: medium
---

# Sessions

Research sessions and collaboration notes.

**Parent:** [[${projectName}]]

## Recent Sessions

_Session notes are auto-generated by the session-end hook._

## Related

- **Decisions:** [[Decisions]]
- **Knowledge:** [[Knowledge]]
`;
}

export function getKnowledgeMocTemplate(): string {
  return `---
description: "MOC - General knowledge, research, ideas"
type: moc
relevance: medium
---

# Knowledge

General knowledge not specific to any project.

## Research

_Research findings and analysis._

## Ideas

_Ideas for future exploration._

## Related

- **Archive:** [[Archive]]
`;
}

export function getArchiveMocTemplate(): string {
  return `---
description: "MOC - Archived and deprecated content"
type: moc
relevance: low
---

# Archive

Archived content. Kept for historical reference.

## Legacy

_Old versions of documents, deprecated approaches._

## Changelogs

_Historical change logs._
`;
}

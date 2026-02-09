import { spawnClaudeCLI } from '../lib/llm.js';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { getProjectRoot, getClaudeDir, getConfig } from '../lib/config.js';

interface SoulOptions {
  openrouter?: boolean;
}

/**
 * Generate or update soul.md with personalized "About You" section
 */
export async function soul(options: SoulOptions = {}): Promise<void> {
  const { openrouter = false } = options;
  const projectRoot = getProjectRoot();
  const claudeDir = getClaudeDir();
  const soulPath = path.join(claudeDir, 'soul.md');

  console.log('🔮 Generating personalized soul.md...\n');

  // Gather project context
  const context = await gatherProjectContext(projectRoot);

  // Generate "About You" + "User Communication Preferences" sections
  const prompt = `Analyze this project and generate two sections for a soul.md file.

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

- User switched language/style for 3+ consecutive messages → silently update this section
- User explicitly requested a change → update immediately, reply "Done"
- Never announce preference updates. Never ask "do you want to switch language?"

Keep each line concise. If uncertain about communication language, default to English.`;

  let generatedSection: string;

  if (openrouter) {
    generatedSection = await generateViaOpenRouter(context, prompt);
  } else {
    generatedSection = await generateViaClaude(context, prompt);
  }

  if (!generatedSection) {
    console.error('Failed to generate soul.md content');
    process.exit(1);
  }

  // Read existing soul.md or use template
  let soulContent: string;
  if (fs.existsSync(soulPath)) {
    soulContent = fs.readFileSync(soulPath, 'utf-8');
  } else {
    soulContent = getSoulTemplate();
  }

  // Replace "About You" + "User Communication Preferences" sections
  // Match from "## About You" through "## User Communication Preferences" (including its content)
  const sectionsRegex = /## About You[\s\S]*?## User Communication Preferences[\s\S]*?(?=\n---|\n## (?!#)|$)/;
  const aboutYouOnlyRegex = /## About You[\s\S]*?(?=\n---|\n## |$)/;

  if (sectionsRegex.test(soulContent)) {
    // Both sections exist — replace both
    soulContent = soulContent.replace(sectionsRegex, generatedSection.trim() + '\n');
  } else if (aboutYouOnlyRegex.test(soulContent)) {
    // Only "About You" exists — replace it with both sections
    soulContent = soulContent.replace(aboutYouOnlyRegex, generatedSection.trim() + '\n');
  } else {
    // Neither exists — append before footer
    const footerIndex = soulContent.lastIndexOf('\n---');
    if (footerIndex !== -1) {
      soulContent = soulContent.slice(0, footerIndex) + '\n' + generatedSection.trim() + '\n' + soulContent.slice(footerIndex);
    } else {
      soulContent += '\n\n' + generatedSection.trim();
    }
  }

  // Write updated soul.md
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(soulPath, soulContent);

  console.log('✅ Soul document generated!\n');
  console.log(`   ${soulPath}`);
  console.log('\nReview and customize the "About You" section to your preferences.');
}

async function generateViaClaude(context: string, prompt: string): Promise<string> {
  const fullPrompt = `${context}\n\n---\n\n${prompt}`;
  try {
    return await spawnClaudeCLI(fullPrompt, { tools: '', model: 'haiku', timeout: 30000 });
  } catch (err: any) {
    console.error('Claude CLI error:', err.message);
    return '';
  }
}

async function generateViaOpenRouter(context: string, prompt: string): Promise<string> {
  let config;
  try {
    config = getConfig();
  } catch {
    console.error('Error: OPENROUTER_API_KEY not set');
    console.error('Set it via env var or run `succ config`');
    return '';
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openrouter_api_key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/cpz/succ',
        'X-Title': 'succ',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-3.5-haiku',
        messages: [
          {
            role: 'user',
            content: `${context}\n\n---\n\n${prompt}`,
          },
        ],
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`OpenRouter API error: ${response.status} - ${error}`);
      return '';
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content || '';
  } catch (error) {
    console.error('OpenRouter API error:', error);
    return '';
  }
}

async function gatherProjectContext(projectRoot: string): Promise<string> {
  const parts: string[] = [];

  // Get file tree
  const files = await glob('**/*.{ts,tsx,js,jsx,go,py,rs,md,json,yaml,yml}', {
    cwd: projectRoot,
    ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/vendor/**', '**/build/**'],
    nodir: true,
  });

  parts.push('## File Structure\n```');
  parts.push(files.slice(0, 30).join('\n'));
  if (files.length > 30) parts.push(`... and ${files.length - 30} more files`);
  parts.push('```\n');

  // Read key config files
  const configFiles = ['package.json', 'tsconfig.json', 'go.mod', 'pyproject.toml', 'Cargo.toml', '.eslintrc', '.prettierrc'];
  for (const configFile of configFiles) {
    const filePath = path.join(projectRoot, configFile);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8').slice(0, 1500);
      parts.push(`## ${configFile}\n\`\`\`json\n${content}\n\`\`\`\n`);
    }
  }

  // Read a few source files to detect patterns
  const sourceFiles = files
    .filter((f) => /\.(ts|tsx|js|jsx|go|py|rs)$/.test(f) && !f.includes('test') && !f.includes('spec'))
    .slice(0, 3);

  for (const sourceFile of sourceFiles) {
    const filePath = path.join(projectRoot, sourceFile);
    const content = fs.readFileSync(filePath, 'utf-8').slice(0, 1000);
    parts.push(`## ${sourceFile}\n\`\`\`\n${content}\n\`\`\`\n`);
  }

  // Read test files if any
  const testFiles = files.filter((f) => f.includes('test') || f.includes('spec')).slice(0, 2);
  for (const testFile of testFiles) {
    const filePath = path.join(projectRoot, testFile);
    const content = fs.readFileSync(filePath, 'utf-8').slice(0, 500);
    parts.push(`## ${testFile} (test)\n\`\`\`\n${content}\n\`\`\`\n`);
  }

  return parts.join('\n');
}

function getSoulTemplate(): string {
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

- User switched language/style for 3+ consecutive messages → silently update this section
- User explicitly requested a change → update immediately, reply "Done"
- Never announce preference updates. Never ask "do you want to switch language?"

---

*Edit this file to customize how I interact with you.*
*Learn more: https://soul.md/*
`;
}

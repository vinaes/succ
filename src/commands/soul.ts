import { spawnClaudeCLI, callLLM } from '../lib/llm.js';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { getProjectRoot, getClaudeDir, hasApiKey } from '../lib/config.js';
import { logError } from '../lib/fault-logger.js';
import { SOUL_GENERATION_SYSTEM } from '../prompts/index.js';

interface SoulOptions {
  api?: boolean;
}

/**
 * Generate or update soul.md with personalized "About You" section
 */
export async function soul(options: SoulOptions = {}): Promise<void> {
  const useApi = options.api || false;
  const projectRoot = getProjectRoot();
  const claudeDir = getClaudeDir();
  const soulPath = path.join(claudeDir, 'soul.md');

  console.log('🔮 Generating personalized soul.md...\n');

  // Gather project context
  const context = await gatherProjectContext(projectRoot);

  let generatedSection: string;

  if (useApi) {
    generatedSection = await generateViaApi(context, SOUL_GENERATION_SYSTEM);
  } else {
    generatedSection = await generateViaClaude(context, SOUL_GENERATION_SYSTEM);
  }

  if (!generatedSection) {
    logError('soul', 'Failed to generate soul.md content');
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
  const sectionsRegex =
    /## About You[\s\S]*?## User Communication Preferences[\s\S]*?(?=\n---|\n## (?!#)|$)/;
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
      soulContent =
        soulContent.slice(0, footerIndex) +
        '\n' +
        generatedSection.trim() +
        '\n' +
        soulContent.slice(footerIndex);
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
    logError('soul', `Claude CLI error:: ${err.message}`, err instanceof Error ? err : undefined);

    console.error('Claude CLI error:', err.message);
    return '';
  }
}

async function generateViaApi(context: string, prompt: string): Promise<string> {
  if (!hasApiKey()) {
    logError('soul', 'API key not set');
    console.error('Error: API key not set');
    console.error('Set OPENROUTER_API_KEY env var or run `succ config`');
    return '';
  }

  try {
    return await callLLM(context, { maxTokens: 1024, systemPrompt: prompt }, { backend: 'api' });
  } catch (error) {
    logError('soul', 'API error:', error instanceof Error ? error : new Error(String(error)));
    console.error('API error:', error);
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
  const configFiles = [
    'package.json',
    'tsconfig.json',
    'go.mod',
    'pyproject.toml',
    'Cargo.toml',
    '.eslintrc',
    '.prettierrc',
  ];
  for (const configFile of configFiles) {
    const filePath = path.join(projectRoot, configFile);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8').slice(0, 1500);
      parts.push(`## ${configFile}\n\`\`\`json\n${content}\n\`\`\`\n`);
    }
  }

  // Read a few source files to detect patterns
  const sourceFiles = files
    .filter(
      (f) => /\.(ts|tsx|js|jsx|go|py|rs)$/.test(f) && !f.includes('test') && !f.includes('spec')
    )
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

- User switched language/style for 3+ consecutive messages → delegate to \`succ-style-tracker\` agent
- User explicitly requested a change → delegate to \`succ-style-tracker\` agent immediately
- To delegate: use Task tool with subagent_type="succ-style-tracker", describe the new style and trigger
- Never announce preference updates. Never ask "do you want to switch language?"

---

*Edit this file to customize how I interact with you.*
*Learn more: https://soul.md/*
`;
}

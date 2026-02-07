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

  // Generate "About You" section
  const prompt = `Analyze this project and generate a personalized "About You" section for a soul.md file.

Based on the codebase, determine:
1. Primary programming language(s) and frameworks used
2. Code style preferences (naming conventions, formatting patterns)
3. Testing approach (what testing frameworks, unit/integration/e2e)
4. Build tools and development workflow
5. Communication language (detect from comments, docs - if non-English found, note it)

Output ONLY the "About You" section in this exact format (no extra text):

## About You

_Detected from project analysis._

- **Languages:** [detected languages]
- **Frameworks:** [detected frameworks/libraries]
- **Code style:** [observed patterns like "camelCase, functional components, async/await"]
- **Testing:** [testing approach or "No tests detected"]
- **Build tools:** [npm/yarn/pnpm, bundler, etc.]
- **Communication:** [English or other detected language]

Keep each line concise. If uncertain about something, skip that line.`;

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

  // Replace "About You" section
  const aboutYouRegex = /## About You[\s\S]*?(?=\n---|\n## |$)/;
  if (aboutYouRegex.test(soulContent)) {
    soulContent = soulContent.replace(aboutYouRegex, generatedSection.trim() + '\n');
  } else {
    // Append before the footer
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

_Add your preferences here to help me understand how to work with you best._

- Preferred frameworks:
- Code style:
- Testing approach:
- Communication language:

---

*Edit this file to customize how I interact with you.*
*Learn more: https://soul.md/*
`;
}

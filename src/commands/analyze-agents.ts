import fs from 'fs';
import path from 'path';
import ora from 'ora';
import { spawnClaudeCLI } from '../lib/llm.js';
import { getLLMTaskConfig } from '../lib/config.js';
import { NetworkError } from '../lib/errors.js';
import { logError } from '../lib/fault-logger.js';
import {
  writeAgentOutput,
  formatDuration,
  printTimingSummary,
  type AgentTiming,
} from './analyze-utils.js';
import { PROJECT_ANALYSIS_WRAPPER, DOCUMENTATION_WRITER_SYSTEM } from '../prompts/index.js';

export interface Agent {
  name: string;
  outputPath: string;
  prompt: string;
}

export function getAgents(brainDir: string, projectName: string): Agent[] {
  const projectDir = path.join(brainDir, 'project');

  // Obsidian formatting guide — injected into every agent prompt
  const obsidianGuide = [
    'OUTPUT FORMAT: Obsidian-compatible markdown for a knowledge vault.',
    '',
    'Use these freely:',
    '- **[[wikilinks]]** to link between docs (e.g. [[Architecture Overview]], [[Memory System]])',
    '- **Mermaid diagrams** for architecture, data flows, sequences, class relations:',
    '  ```mermaid',
    '  graph TD',
    '    A[CLI] --> B[MCP Server]',
    '    B --> C[Storage]',
    '  ```',
    '- **ASCII art** for quick diagrams when Mermaid is overkill',
    '- **Tables** for structured data (deps, configs, API params, comparisons)',
    '- **Code blocks** with language tags (```typescript, ```bash)',
    '- **Callouts**: > [!note], > [!warning], > [!tip]',
    '- **Bold** for key terms, `inline code` for file paths and identifiers',
    '',
    'CRITICAL MERMAID RULE: NEVER use [[wikilinks]] inside ```mermaid blocks — Mermaid does not support them and they break rendering.',
    'Inside mermaid: use plain text labels like A["Storage System"] not A[[Storage System]].',
    'Wikilinks like [[Storage System]] are ONLY for regular markdown text outside of code blocks.',
    '',
    'Be thorough and visual. Prefer diagrams over walls of text.',
    'Reference REAL file paths from the codebase — never guess or hallucinate paths.',
    '',
  ].join('\n');

  // Helper for frontmatter + obsidian guide
  const frontmatter = (desc: string, type: string = 'technical', rel: string = 'high') =>
    `Start with this YAML frontmatter:\n---\ndescription: "${desc}"\nproject: ${projectName}\ntype: ${type}\nrelevance: ${rel}\n---\n\n${obsidianGuide}`;

  const agents: Agent[] = [
    // Technical documentation
    {
      name: 'architecture',
      outputPath: path.join(projectDir, 'Technical', 'Architecture Overview.md'),
      prompt: `${frontmatter('High-level architecture overview')}Create "# Architecture Overview" document.

Add "**Parent:** [[${projectName}]]" after title.

Include sections: Overview, Tech Stack, Directory Structure, Entry Points, Data Flow.

Use [[wikilinks]] for related concepts. Output ONLY markdown.`,
    },
    {
      name: 'api',
      outputPath: path.join(projectDir, 'Technical', 'API Reference.md'),
      prompt: `${frontmatter('API endpoints and interfaces')}Create "# API Reference" document.

Add "**Parent:** [[Architecture Overview]]" after title.

List all API endpoints, CLI commands, or main public functions with their parameters and return types.

Output ONLY markdown.`,
    },
    {
      name: 'conventions',
      outputPath: path.join(projectDir, 'Technical', 'Conventions.md'),
      prompt: `${frontmatter('Coding conventions and patterns', 'technical', 'medium')}Create "# Conventions" document.

Add "**Parent:** [[Architecture Overview]]" after title.

Document: naming conventions, file organization, common patterns, error handling approach.

Output ONLY markdown.`,
    },
    {
      name: 'dependencies',
      outputPath: path.join(projectDir, 'Technical', 'Dependencies.md'),
      prompt: `${frontmatter('Key dependencies and their purposes', 'technical', 'medium')}Create "# Dependencies" document.

Add "**Parent:** [[Architecture Overview]]" after title.

List important dependencies with: name, purpose, where used. Group by category.

Output ONLY markdown.`,
    },

    // Strategy (if business logic exists)
    {
      name: 'strategy',
      outputPath: path.join(projectDir, 'Strategy', 'Project Strategy.md'),
      prompt: `${frontmatter('Project goals and strategic direction', 'strategy')}Create "# Project Strategy" document.

Add "**Parent:** [[${projectName}]]" after title.

Based on the codebase, describe:
- What problem this project solves
- Target users/audience
- Key differentiators
- Current capabilities
- Potential growth areas

If this is a library/tool, focus on its use cases. Output ONLY markdown.`,
    },
  ];

  return agents;
}

export async function runAgentsParallel(agents: Agent[], context: string): Promise<void> {
  console.log(`Starting ${agents.length} agents in parallel...\n`);

  const totalStart = Date.now();
  const agentStarts = agents.map(() => Date.now());
  const promises = agents.map((agent, i) => {
    agentStarts[i] = Date.now();
    return runClaudeAgent(agent, context);
  });
  const results = await Promise.allSettled(promises);

  const timings: AgentTiming[] = [];
  results.forEach((result, index) => {
    const elapsed = Date.now() - agentStarts[index];
    if (result.status === 'fulfilled') {
      console.log(`✓ ${agents[index].name} (${formatDuration(elapsed)})`);
      timings.push({ name: agents[index].name, durationMs: elapsed, success: true });
    } else {
      console.log(`✗ ${agents[index].name}: ${result.reason}`);
      timings.push({ name: agents[index].name, durationMs: elapsed, success: false });
    }
  });

  printTimingSummary(timings, Date.now() - totalStart);
}

export async function runAgentsSequential(agents: Agent[], context: string): Promise<void> {
  console.log(`Running ${agents.length} agents sequentially...\n`);

  const totalStart = Date.now();
  const timings: AgentTiming[] = [];
  for (const agent of agents) {
    const spinner = ora(`${agent.name}`).start();
    const agentStart = Date.now();
    try {
      await runClaudeAgent(agent, context);
      const elapsed = Date.now() - agentStart;
      spinner.succeed(`${agent.name} (${formatDuration(elapsed)})`);
      timings.push({ name: agent.name, durationMs: elapsed, success: true });
    } catch (error) {
      logError(
        'analyze',
        `Agent ${agent.name} failed`,
        error instanceof Error ? error : new Error(String(error))
      );
      const elapsed = Date.now() - agentStart;
      spinner.fail(`${agent.name}: ${error}`);
      timings.push({ name: agent.name, durationMs: elapsed, success: false });
    }
  }

  printTimingSummary(timings, Date.now() - totalStart);
}

export async function runClaudeAgent(agent: Agent, context: string): Promise<void> {
  // Ensure output directory exists
  const outputDir = path.dirname(agent.outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  // Build prompt with context
  const fullPrompt = PROJECT_ANALYSIS_WRAPPER.replace('{context}', context).replace(
    '{agent_prompt}',
    agent.prompt
  );

  const stdout = await spawnClaudeCLI(fullPrompt, { tools: '', model: 'haiku', timeout: 180000 });

  if (stdout) {
    await writeAgentOutput(agent, stdout);
  } else {
    throw new NetworkError('No output from Claude CLI');
  }
}

type ProgressFn = (status: string, completed: number, total: number, current?: string) => void;

/**
 * Run agents using API endpoint (OpenRouter, Ollama, LM Studio, llama.cpp, etc.)
 */
export async function runAgentsApi(
  agents: Agent[],
  context: string,
  writeProgress: ProgressFn,
  fast = false
): Promise<void> {
  const cfg = getLLMTaskConfig('analyze');

  console.log(`Running ${agents.length} agents via API...`);
  console.log(`  Endpoint: ${cfg.api_url}`);
  console.log(`  Model: ${cfg.model}\n`);

  const totalStart = Date.now();
  const timings: AgentTiming[] = [];
  let completed = 0;
  for (const agent of agents) {
    writeProgress('running', completed, agents.length, agent.name);
    const spinner = ora(`${agent.name}`).start();
    const agentStart = Date.now();

    // Multi-file agents (systems-overview, features) need more output tokens
    const isMultiFile = agent.prompt.includes('===FILE:');
    const agentMaxTokens =
      cfg.max_tokens ?? (isMultiFile ? (fast ? 4096 : 32768) : fast ? 2048 : 8192);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (cfg.api_key) {
        headers['Authorization'] = `Bearer ${cfg.api_key}`;
      }
      // Auto-add OpenRouter headers
      if (cfg.api_url.includes('openrouter.ai')) {
        headers['HTTP-Referer'] = 'https://succ.ai';
        headers['X-Title'] = 'succ';
      }

      // Build the completion endpoint URL
      const apiUrl = cfg.api_url;
      const completionUrl = apiUrl.endsWith('/v1')
        ? `${apiUrl}/chat/completions`
        : apiUrl.endsWith('/v1/')
          ? `${apiUrl}chat/completions`
          : apiUrl.endsWith('/')
            ? `${apiUrl}v1/chat/completions`
            : `${apiUrl}/v1/chat/completions`;

      const response = await fetch(completionUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            {
              role: 'system',
              content: DOCUMENTATION_WRITER_SYSTEM,
            },
            {
              role: 'user',
              content: `You are analyzing a software project. Here is the project structure and key files:\n\n${context}\n\n---\n\n${agent.prompt}`,
            },
          ],
          temperature: cfg.temperature ?? 0.3,
          max_tokens: agentMaxTokens,
          stream: false,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new NetworkError(`API error: ${response.status} - ${error}`, response.status);
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;

      if (content) {
        await writeAgentOutput(agent, content);
        completed++;
        const elapsed = Date.now() - agentStart;
        spinner.succeed(`${agent.name} (${formatDuration(elapsed)})`);
        timings.push({ name: agent.name, durationMs: elapsed, success: true });
      } else {
        const elapsed = Date.now() - agentStart;
        spinner.fail(`${agent.name}: No content returned`);
        timings.push({ name: agent.name, durationMs: elapsed, success: false });
      }
    } catch (error) {
      logError(
        'analyze',
        `Agent ${agent.name} failed`,
        error instanceof Error ? error : new Error(String(error))
      );
      const elapsed = Date.now() - agentStart;
      spinner.fail(`${agent.name}: ${error}`);
      timings.push({ name: agent.name, durationMs: elapsed, success: false });
    }
  }

  printTimingSummary(timings, Date.now() - totalStart);
}

/**
 * Factory: returns a callLLM function for the given mode.
 */
export function createLLMCaller(
  mode: 'api' | 'claude',
  maxTokens: number
): (prompt: string, context: string) => Promise<string> {
  const systemPrompt =
    'You are analyzing a software project. Provide concrete, actionable insights.';

  return async (prompt: string, context: string) => {
    const userContent = `Project context:\n\n${context}\n\n---\n\n${prompt}`;

    if (mode === 'api') {
      // Use callApiRaw from analyze-profile.ts
      await import('./analyze-profile.js');
      const cfg = getLLMTaskConfig('analyze');
      const apiUrl = cfg.api_url;

      const completionUrl = apiUrl.endsWith('/v1')
        ? `${apiUrl}/chat/completions`
        : apiUrl.endsWith('/v1/')
          ? `${apiUrl}chat/completions`
          : apiUrl.endsWith('/')
            ? `${apiUrl}v1/chat/completions`
            : `${apiUrl}/v1/chat/completions`;

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (cfg.api_key) {
        headers['Authorization'] = `Bearer ${cfg.api_key}`;
      }
      if (apiUrl.includes('openrouter.ai')) {
        headers['HTTP-Referer'] = 'https://succ.ai';
        headers['X-Title'] = 'succ';
      }

      const response = await fetch(completionUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          max_tokens: maxTokens,
        }),
      });
      if (!response.ok) {
        const error = await response.text();
        throw new NetworkError(`API error: ${response.status} - ${error}`, response.status);
      }
      const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      return data.choices?.[0]?.message?.content || '';
    } else {
      // Claude CLI mode — use spawnClaudeCLI
      return spawnClaudeCLI(`System: ${systemPrompt}\n\n${userContent}`);
    }
  };
}

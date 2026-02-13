import fs from 'fs';
import path from 'path';
import os from 'os';
import inquirer from 'inquirer';
import { LOCAL_MODEL, getConfigDisplay, formatConfigDisplay, getSuccDir, invalidateConfigCache } from '../lib/config.js';

interface ConfigData {
  llm?: {
    api_key?: string;
    api_url?: string;
    embeddings?: {
      mode?: 'local' | 'api';
      model?: string;
    };
  };
  chunk_size?: number;
  chunk_overlap?: number;
}

export interface ConfigOptions {
  show?: boolean;
  json?: boolean;
}

export interface ConfigSetOptions {
  project?: boolean;
}

/**
 * Show current configuration (non-interactive)
 */
export async function showConfig(options: { json?: boolean } = {}): Promise<void> {
  const display = getConfigDisplay(true);

  if (options.json) {
    console.log(JSON.stringify(display, null, 2));
  } else {
    console.log(formatConfigDisplay(display));
  }
}

/**
 * Interactive configuration wizard
 */
export async function config(options: ConfigOptions = {}): Promise<void> {
  // If --show flag, display current config and exit
  if (options.show) {
    await showConfig({ json: options.json });
    return;
  }
  const globalConfigDir = path.join(os.homedir(), '.succ');
  const globalConfigPath = path.join(globalConfigDir, 'config.json');

  // Load existing config
  let existingConfig: Record<string, unknown> = {};
  if (fs.existsSync(globalConfigPath)) {
    try {
      existingConfig = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
    } catch {
      // Ignore parse errors
    }
  }

  const existingLlm = (existingConfig.llm || {}) as Record<string, unknown>;
  const existingEmbeddings = (existingLlm.embeddings || {}) as Record<string, unknown>;

  console.log('succ configuration wizard\n');

  // Step 1: API key (used for OpenRouter, remote APIs)
  const { apiKey } = await inquirer.prompt([
    {
      type: 'password',
      name: 'apiKey',
      message: 'API key (OpenRouter / remote LLM, press Enter to skip):',
      default: (existingLlm.api_key as string) || '',
    },
  ]);

  // Step 2: Choose embedding mode
  const { mode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: 'Select embedding mode:',
      choices: [
        {
          name: 'Local (default) - runs on CPU, no API key needed',
          value: 'local',
        },
        {
          name: 'API - any OpenAI-compatible endpoint (OpenRouter, Ollama, etc.)',
          value: 'api',
        },
      ],
      default: (existingEmbeddings.mode as string) || 'local',
    },
  ]);

  const newConfig: ConfigData = {
    llm: {
      embeddings: { mode },
    },
  };

  if (apiKey) {
    newConfig.llm!.api_key = apiKey;
  }

  // Step 3: Mode-specific configuration
  if (mode === 'local') {
    const { model } = await inquirer.prompt([
      {
        type: 'input',
        name: 'model',
        message: 'Local model (Hugging Face model ID):',
        default: (existingEmbeddings.model as string) || LOCAL_MODEL,
      },
    ]);
    newConfig.llm!.embeddings!.model = model;
  } else if (mode === 'api') {
    const { apiUrl, model } = await inquirer.prompt([
      {
        type: 'input',
        name: 'apiUrl',
        message: 'API URL (e.g., https://openrouter.ai/api/v1 or http://localhost:11434/v1):',
        default: (existingEmbeddings.api_url as string) || (existingLlm.api_url as string) || 'https://openrouter.ai/api/v1',
        validate: (input: string) => {
          try {
            new URL(input);
            return true;
          } catch {
            return 'Please enter a valid URL';
          }
        },
      },
      {
        type: 'input',
        name: 'model',
        message: 'Embedding model:',
        default: (existingEmbeddings.model as string) || 'openai/text-embedding-3-small',
      },
    ]);
    newConfig.llm!.api_url = apiUrl;
    newConfig.llm!.embeddings!.model = model;
  }

  // Step 4: Advanced options
  const { configureAdvanced } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'configureAdvanced',
      message: 'Configure advanced options (chunk size, overlap)?',
      default: false,
    },
  ]);

  if (configureAdvanced) {
    const { chunkSize, chunkOverlap } = await inquirer.prompt([
      {
        type: 'number',
        name: 'chunkSize',
        message: 'Chunk size (characters):',
        default: (existingConfig.chunk_size as number) || 500,
      },
      {
        type: 'number',
        name: 'chunkOverlap',
        message: 'Chunk overlap (characters):',
        default: (existingConfig.chunk_overlap as number) || 50,
      },
    ]);
    newConfig.chunk_size = chunkSize;
    newConfig.chunk_overlap = chunkOverlap;
  }

  // Save config
  if (!fs.existsSync(globalConfigDir)) {
    fs.mkdirSync(globalConfigDir, { recursive: true });
  }

  // Deep merge with existing config
  const finalConfig = deepMerge(existingConfig, newConfig as unknown as Record<string, unknown>);

  fs.writeFileSync(globalConfigPath, JSON.stringify(finalConfig, null, 2));

  console.log(`\nConfiguration saved to ${globalConfigPath}`);
  console.log('\nCurrent configuration:');
  console.log(JSON.stringify(finalConfig, null, 2));
}

/**
 * Deep merge two objects (target wins on conflicts)
 */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (override[key] && typeof override[key] === 'object' && !Array.isArray(override[key]) &&
        result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, override[key] as Record<string, unknown>);
    } else if (override[key] !== undefined && override[key] !== '') {
      result[key] = override[key];
    }
  }
  return result;
}

/**
 * Set a single config key (non-interactive)
 *
 * Usage:
 *   succ config set <key> <value>
 *   succ config set <key> <value> --project
 */
export async function configSet(key: string, value: string, options: ConfigSetOptions = {}): Promise<void> {
  // Determine config path
  let configDir: string;
  let configPath: string;

  if (options.project) {
    const succDir = getSuccDir();
    if (!fs.existsSync(succDir)) {
      console.error('Project not initialized. Run `succ init` first or omit --project for global config.');
      process.exitCode = 1;
      return;
    }
    configDir = succDir;
    configPath = path.join(succDir, 'config.json');
  } else {
    configDir = path.join(os.homedir(), '.succ');
    configPath = path.join(configDir, 'config.json');
  }

  // Load existing config
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      // Start fresh if corrupted
    }
  }

  // Parse value (handle booleans and numbers)
  let parsedValue: unknown = value;
  if (value === 'true') parsedValue = true;
  else if (value === 'false') parsedValue = false;
  else if (!isNaN(Number(value)) && value.trim() !== '') parsedValue = Number(value);

  // Handle nested keys (e.g., "llm.embeddings.mode")
  const keys = key.split('.');
  if (keys.length === 1) {
    config[key] = parsedValue;
  } else {
    let current: Record<string, unknown> = config;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
        current[keys[i]] = {};
      }
      current = current[keys[i]] as Record<string, unknown>;
    }
    current[keys[keys.length - 1]] = parsedValue;
  }

  // Ensure config directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Save config
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Invalidate cached config so subsequent reads see the new value
  invalidateConfigCache();

  const scope = options.project ? 'project' : 'global';
  console.log(`Config updated (${scope}): ${key} = ${JSON.stringify(parsedValue)}`);
  console.log(`Saved to: ${configPath}`);
}

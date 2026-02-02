import fs from 'fs';
import path from 'path';
import os from 'os';
import inquirer from 'inquirer';
import { LOCAL_MODEL, OPENROUTER_MODEL, getConfigDisplay, formatConfigDisplay } from '../lib/config.js';

interface ConfigData {
  embedding_mode: 'local' | 'openrouter' | 'custom';
  embedding_model?: string;
  openrouter_api_key?: string;
  embedding_api_url?: string;
  embedding_api_key?: string;
  chunk_size?: number;
  chunk_overlap?: number;
}

export interface ConfigOptions {
  show?: boolean;
  json?: boolean;
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
  let existingConfig: Partial<ConfigData> = {};
  if (fs.existsSync(globalConfigPath)) {
    try {
      existingConfig = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
    } catch {
      // Ignore parse errors
    }
  }

  console.log('succ configuration wizard\n');

  // Step 1: Choose embedding mode
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
          name: 'OpenRouter - cloud embeddings via OpenRouter API',
          value: 'openrouter',
        },
        {
          name: 'Custom API - use your own OpenAI-compatible endpoint',
          value: 'custom',
        },
      ],
      default: existingConfig.embedding_mode || 'local',
    },
  ]);

  const newConfig: ConfigData = {
    embedding_mode: mode,
  };

  // Step 2: Mode-specific configuration
  if (mode === 'local') {
    const { model } = await inquirer.prompt([
      {
        type: 'input',
        name: 'model',
        message: 'Local model (Hugging Face model ID):',
        default: existingConfig.embedding_model || LOCAL_MODEL,
      },
    ]);
    newConfig.embedding_model = model;
  } else if (mode === 'openrouter') {
    const { apiKey, model } = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'OpenRouter API key:',
        default: existingConfig.openrouter_api_key,
        validate: (input: string) => {
          if (!input || input.trim() === '') {
            return 'API key is required for OpenRouter mode';
          }
          return true;
        },
      },
      {
        type: 'input',
        name: 'model',
        message: 'Embedding model:',
        default: existingConfig.embedding_model || OPENROUTER_MODEL,
      },
    ]);
    newConfig.openrouter_api_key = apiKey;
    newConfig.embedding_model = model;
  } else if (mode === 'custom') {
    const { apiUrl, apiKey, model } = await inquirer.prompt([
      {
        type: 'input',
        name: 'apiUrl',
        message: 'Custom API URL (e.g., http://localhost:1234/v1/embeddings):',
        default: existingConfig.embedding_api_url,
        validate: (input: string) => {
          if (!input || input.trim() === '') {
            return 'API URL is required for custom mode';
          }
          try {
            new URL(input);
            return true;
          } catch {
            return 'Please enter a valid URL';
          }
        },
      },
      {
        type: 'password',
        name: 'apiKey',
        message: 'API key (optional, press Enter to skip):',
        default: existingConfig.embedding_api_key || '',
      },
      {
        type: 'input',
        name: 'model',
        message: 'Model name:',
        default: existingConfig.embedding_model || 'text-embedding-3-small',
      },
    ]);
    newConfig.embedding_api_url = apiUrl;
    if (apiKey) {
      newConfig.embedding_api_key = apiKey;
    }
    newConfig.embedding_model = model;
  }

  // Step 3: Advanced options
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
        default: existingConfig.chunk_size || 500,
      },
      {
        type: 'number',
        name: 'chunkOverlap',
        message: 'Chunk overlap (characters):',
        default: existingConfig.chunk_overlap || 50,
      },
    ]);
    newConfig.chunk_size = chunkSize;
    newConfig.chunk_overlap = chunkOverlap;
  }

  // Save config
  if (!fs.existsSync(globalConfigDir)) {
    fs.mkdirSync(globalConfigDir, { recursive: true });
  }

  // Merge with existing config (preserve fields we didn't ask about)
  const finalConfig = { ...existingConfig, ...newConfig };

  // Clean up undefined/empty values
  for (const key of Object.keys(finalConfig) as Array<keyof ConfigData>) {
    if (finalConfig[key] === undefined || finalConfig[key] === '') {
      delete finalConfig[key];
    }
  }

  fs.writeFileSync(globalConfigPath, JSON.stringify(finalConfig, null, 2));

  console.log(`\nConfiguration saved to ${globalConfigPath}`);
  console.log('\nCurrent configuration:');
  console.log(JSON.stringify(finalConfig, null, 2));
}

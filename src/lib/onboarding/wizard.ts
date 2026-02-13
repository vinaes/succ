/**
 * Static Onboarding Wizard
 *
 * Quick interactive onboarding (~2 min) using predefined screens.
 * For users who don't want AI-powered chat or don't have LLM configured.
 */

import * as readline from 'readline';
import {
  WIZARD_INTRO,
  WIZARD_DISCOVERY_PROJECT,
  WIZARD_DISCOVERY_FRUSTRATION,
  WIZARD_SOLUTION_MAP,
  WIZARD_CONCEPTS_OVERVIEW,
  WIZARD_HANDS_ON_PROMPT,
  WIZARD_CHEATSHEET,
  WIZARD_DONE,
} from '../../prompts/index.js';
import { markOnboardingCompleted } from '../config.js';

function createReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function waitForEnter(rl: readline.Interface): Promise<void> {
  await prompt(rl, '\nPress Enter to continue...');
}

async function selectOption(rl: readline.Interface, options: string[]): Promise<number> {
  while (true) {
    const answer = await prompt(rl, '\nYour choice (1-' + options.length + '): ');
    const num = parseInt(answer, 10);
    if (num >= 1 && num <= options.length) {
      return num;
    }
    console.log('Please enter a number between 1 and ' + options.length);
  }
}

/**
 * Run the static onboarding wizard
 */
export async function runStaticWizard(): Promise<void> {
  const rl = createReadline();

  try {
    // Screen 1: Intro
    console.clear();
    console.log(WIZARD_INTRO);
    await waitForEnter(rl);

    // Screen 2: Project type discovery
    console.clear();
    console.log(WIZARD_DISCOVERY_PROJECT);
    const projectOptions = [
      'Web application',
      'CLI tool / library',
      'Mobile app',
      'Something else',
    ];
    const projectChoice = await selectOption(rl, projectOptions);
    const projectType = projectOptions[projectChoice - 1];

    // Screen 3: Frustration discovery
    console.clear();
    console.log(WIZARD_DISCOVERY_FRUSTRATION);
    const frustrationOptions = [
      'Forgets context between sessions',
      "Doesn't know my codebase patterns",
      'I have to repeat decisions',
      'Takes time to explain project structure',
    ];
    const frustrationChoice = await selectOption(rl, frustrationOptions);

    // Screen 4: Solution mapping based on frustration
    console.clear();
    const frustrationKeys = ['forgets', 'codebase', 'repeat', 'structure'];
    const frustrationKey = frustrationKeys[frustrationChoice - 1];
    console.log(`\nGreat! You're building a ${projectType.toLowerCase()}.\n`);
    console.log(WIZARD_SOLUTION_MAP[frustrationKey]);
    await waitForEnter(rl);

    // Screen 5: Concepts overview
    console.clear();
    console.log(WIZARD_CONCEPTS_OVERVIEW);
    await waitForEnter(rl);

    // Screen 6: Hands-on (optional)
    console.clear();
    console.log(WIZARD_HANDS_ON_PROMPT);
    const decision = await prompt(rl, '> ');

    if (decision) {
      console.log('\nNice! Once setup is complete, this will be stored as:');
      console.log('');
      console.log(`  succ_remember content="${decision}" type="decision"`);
      console.log('');
      console.log('The AI will be able to recall this in future sessions!');
      await waitForEnter(rl);
    }

    // Screen 7: Cheatsheet
    console.clear();
    console.log(WIZARD_CHEATSHEET);
    await waitForEnter(rl);

    // Screen 8: Done
    console.clear();
    console.log(WIZARD_DONE);

    // Mark completed
    markOnboardingCompleted('wizard');
  } finally {
    rl.close();
  }
}

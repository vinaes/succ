/**
 * AI-Powered Onboarding Chat
 *
 * Interactive onboarding using an LLM (chat_llm config).
 * More personalized experience (~3-5 min).
 */

import * as readline from 'readline';
import { ONBOARDING_SYSTEM_PROMPT } from '../../prompts/index.js';
import { callLLMChat, ChatMessage } from '../llm.js';
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

/**
 * Run AI-powered interactive onboarding
 */
export async function runAiOnboarding(): Promise<void> {
  const rl = createReadline();

  try {
    console.clear();
    console.log('Starting AI-powered onboarding...\n');
    console.log('Type "done", "skip", or "exit" at any time to finish.\n');
    console.log('---\n');

    const messages: ChatMessage[] = [
      { role: 'system', content: ONBOARDING_SYSTEM_PROMPT },
    ];

    // Get initial greeting from AI
    try {
      const greeting = await callLLMChat(messages, { timeout: 30000 });
      console.log(`succ: ${greeting}\n`);
      messages.push({ role: 'assistant', content: greeting });
    } catch (error) {
      console.error('\nFailed to connect to LLM. Falling back to static wizard.\n');
      rl.close();
      // Import dynamically to avoid circular dependency
      const { runStaticWizard } = await import('./wizard.js');
      await runStaticWizard();
      return;
    }

    // Chat loop
    let turnCount = 0;
    const maxTurns = 15; // Prevent infinite loops

    while (turnCount < maxTurns) {
      const userInput = await prompt(rl, 'You: ');

      // Check for exit commands
      if (['done', 'skip', 'exit', 'quit', 'q'].includes(userInput.toLowerCase())) {
        console.log('\nGreat! Moving on to setup...\n');
        break;
      }

      // Check for empty input
      if (!userInput) {
        continue;
      }

      messages.push({ role: 'user', content: userInput });

      try {
        const response = await callLLMChat(messages, { timeout: 30000 });
        console.log(`\nsucc: ${response}\n`);
        messages.push({ role: 'assistant', content: response });
      } catch (error) {
        console.error('\nError getting response. Please try again or type "done" to continue.\n');
      }

      turnCount++;
    }

    if (turnCount >= maxTurns) {
      console.log('\nOnboarding session limit reached. Moving on to setup...\n');
    }

    // Mark completed
    markOnboardingCompleted('ai-chat');

  } finally {
    rl.close();
  }
}

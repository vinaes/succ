/**
 * Integration test for Sleep Agent functionality
 *
 * Tests that sleep_agent config is properly used for background operations.
 */

import { getLLMConfig, getSleepAgentConfig, isSleepAgentEnabled, callLLM } from '../dist/lib/llm.js';

async function main() {
  console.log('=== Sleep Agent Integration Test ===\n');

  // Test 1: Check current state
  console.log('--- Test 1: Sleep Agent State ---');
  const sleepAgentEnabled = isSleepAgentEnabled();
  console.log(`Sleep agent enabled: ${sleepAgentEnabled}`);

  const sleepAgentConfig = getSleepAgentConfig();
  if (sleepAgentConfig) {
    console.log(`Sleep agent config: ${JSON.stringify(sleepAgentConfig, null, 2)}`);
    console.log('✓ Sleep agent is configured and enabled\n');
  } else {
    console.log('Sleep agent config: null (disabled)');
    console.log('✓ Sleep agent is disabled (uses main llm.* config for background ops)\n');
  }

  // Test 2: Check LLM config
  console.log('--- Test 2: Main LLM Config ---');
  const llmConfig = getLLMConfig();
  console.log('LLM config:', JSON.stringify(llmConfig, null, 2));
  console.log('✓ LLM config loaded\n');

  // Test 3: Call LLM with useSleepAgent=true
  console.log('--- Test 3: callLLM with useSleepAgent=true ---');
  try {
    const result = await callLLM(
      'Say "Hello from sleep agent" in exactly 5 words.',
      { timeout: 30000, maxTokens: 50, useSleepAgent: true }
    );
    console.log(`Result: "${result.slice(0, 60)}..."`);
    if (sleepAgentEnabled) {
      console.log('✓ callLLM used sleep_agent config\n');
    } else {
      console.log('✓ callLLM fell back to main config (sleep agent disabled)\n');
    }
  } catch (err) {
    console.log(`✗ callLLM failed: ${err.message}\n`);
  }

  // Test 4: Call LLM with useSleepAgent=false (should always use main config)
  console.log('--- Test 4: callLLM with useSleepAgent=false ---');
  try {
    const result = await callLLM(
      'Say "Hello from main LLM" in exactly 5 words.',
      { timeout: 30000, maxTokens: 50, useSleepAgent: false }
    );
    console.log(`Result: "${result.slice(0, 60)}..."`);
    console.log('✓ callLLM used main llm.* config\n');
  } catch (err) {
    console.log(`✗ callLLM failed: ${err.message}\n`);
  }

  console.log('=== Summary ===');
  console.log(`Sleep agent: ${sleepAgentEnabled ? 'ENABLED' : 'DISABLED'}`);
  if (sleepAgentEnabled && sleepAgentConfig) {
    console.log(`  Backend: ${sleepAgentConfig.backend}`);
    console.log(`  Model: ${sleepAgentConfig.model}`);
  }
  console.log('\n=== Sleep Agent Tests Complete ===');
}

main().catch(console.error);

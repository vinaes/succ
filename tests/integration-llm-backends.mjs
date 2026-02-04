#!/usr/bin/env node
// Test script for verifying LLM backend migration

import { callLLM, callLLMWithFallback, getLLMConfig, isLocalLLMAvailable, isOpenRouterConfigured } from '../dist/lib/llm.js';

const testPrompt = 'Say "Hello from LLM" in exactly 5 words.';

async function testBackend(name, configOverride) {
  console.log(`\n--- Testing ${name} backend ---`);
  try {
    const result = await callLLM(testPrompt, { timeout: 30000, maxTokens: 100 }, configOverride);
    console.log(`✓ ${name}: "${result.trim().substring(0, 100)}"`);
    return true;
  } catch (err) {
    console.log(`✗ ${name}: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log('=== LLM Backend Test Suite ===\n');

  // Check availability
  const config = getLLMConfig();
  console.log('Current config:', JSON.stringify(config, null, 2));

  console.log('\n--- Availability Checks ---');
  console.log('Local LLM available:', await isLocalLLMAvailable());
  console.log('OpenRouter configured:', isOpenRouterConfigured());

  // Test each backend
  const results = {};

  // Test local (Ollama) - use model from config
  results.local = await testBackend('local', { backend: 'local', model: config.model });

  // Test OpenRouter
  results.openrouter = await testBackend('openrouter', { backend: 'openrouter', openrouterModel: 'anthropic/claude-3-haiku' });

  // Test fallback chain
  console.log('\n--- Testing Fallback Chain ---');
  try {
    const result = await callLLMWithFallback(testPrompt, { timeout: 30000, maxTokens: 100 });
    console.log(`✓ Fallback: "${result.trim().substring(0, 100)}"`);
    results.fallback = true;
  } catch (err) {
    console.log(`✗ Fallback: ${err.message}`);
    results.fallback = false;
  }

  // Summary
  console.log('\n=== Summary ===');
  for (const [name, ok] of Object.entries(results)) {
    console.log(`${ok ? '✓' : '✗'} ${name}`);
  }

  process.exit(Object.values(results).some(v => v) ? 0 : 1);
}

main().catch(console.error);

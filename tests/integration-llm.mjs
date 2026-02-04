#!/usr/bin/env node
// Integration test: test migrated components work with LLM library

import path from 'path';

// Test 1: compact-briefing
async function testCompactBriefing() {
  console.log('\n=== Testing compact-briefing ===');
  try {
    const { generateCompactBriefing } = await import('../dist/lib/compact-briefing.js');

    // Need at least 200 chars for briefing to work
    // parseTranscript expects JSONL format (Claude Code transcript)
    const testTranscript = [
      JSON.stringify({ type: 'user', message: { content: 'How do I setup a new project with TypeScript?' } }),
      JSON.stringify({ type: 'assistant', message: { content: "I can help you with that. First, let's initialize the project structure. Here's what you need to do:\n\n1. Create a new directory for your project\n2. Run npm init -y to create a package.json\n3. Install TypeScript as a dev dependency: npm install typescript --save-dev\n4. Create a tsconfig.json file with your compiler options\n5. Set up your source directory structure" } }),
      JSON.stringify({ type: 'user', message: { content: 'Thanks, what about the tsconfig.json settings?' } }),
      JSON.stringify({ type: 'assistant', message: { content: "Great question! Here are the recommended settings for a Node.js TypeScript project:\n\n- Set target to ES2022 for modern JavaScript features\n- Use module: NodeNext for ESM support\n- Enable strict mode for better type checking\n- Set outDir to ./dist for compiled output\n- Set rootDir to ./src for source files" } }),
      JSON.stringify({ type: 'user', message: { content: "Perfect, that's really helpful!" } }),
    ].join('\n');

    const result = await generateCompactBriefing(testTranscript, {
      format: 'minimal',
      mode: 'openrouter',
      timeout_ms: 60000,
      include_memories: false,
      include_learnings: false,
    });

    if (result.success && result.briefing) {
      console.log('✓ compact-briefing:', result.briefing.substring(0, 150).replace(/\n/g, ' ') + '...');
      return true;
    } else {
      console.log('✗ compact-briefing:', result.error);
      return false;
    }
  } catch (err) {
    console.log('✗ compact-briefing:', err.message);
    return false;
  }
}

// Test 2: session-summary (extractFactsWithLLM)
async function testSessionSummary() {
  console.log('\n=== Testing session-summary ===');
  try {
    const { extractFactsWithLLM } = await import('../dist/lib/session-summary.js');

    const testTranscript = `
User: How do I implement authentication?
Assistant: I recommend using JWT tokens. Here's the approach:
1. Create a login endpoint
2. Generate JWT on successful login
3. Use middleware to verify tokens

User: Thanks, that worked!
`;

    const facts = await extractFactsWithLLM(testTranscript, {
      mode: 'openrouter',
      projectPath: process.cwd(),
      model: 'anthropic/claude-3-haiku',
    });

    console.log('✓ session-summary: extracted', facts.length, 'facts');
    if (facts.length > 0) {
      console.log('  First fact:', JSON.stringify(facts[0]).substring(0, 100));
    }
    return true;
  } catch (err) {
    console.log('✗ session-summary:', err.message);
    return false;
  }
}

// Test 3: consolidate
async function testConsolidate() {
  console.log('\n=== Testing consolidate (llmMergeContent) ===');
  try {
    const { llmMergeContent } = await import('../dist/lib/consolidate.js');

    const content1 = 'User prefers dark mode for all applications';
    const content2 = 'User likes dark themes and minimalist design';

    const result = await llmMergeContent(content1, content2, {
      mode: 'openrouter',
      model: 'anthropic/claude-3-haiku',
      timeoutMs: 30000,
    });

    if (result) {
      console.log('✓ consolidate:', result.substring(0, 100).replace(/\n/g, ' '));
      return true;
    } else {
      console.log('✗ consolidate: returned null');
      return false;
    }
  } catch (err) {
    console.log('✗ consolidate:', err.message);
    return false;
  }
}

// Test 4: precompute-context
async function testPrecomputeContext() {
  console.log('\n=== Testing precompute-context ===');
  try {
    const { precomputeContext } = await import('../dist/lib/precompute-context.js');

    const testTranscript = `
User: I need help with the authentication system
Assistant: I'll help you implement authentication. Let me check the existing code structure first.
The auth system uses JWT tokens stored in httpOnly cookies for security.
User: Can you add a refresh token mechanism?
Assistant: I've added refresh token support with a 7-day expiry and automatic rotation on use.
`;

    const result = await precomputeContext(testTranscript, {
      verbose: false,
      dryRun: true,  // Don't actually write files
      openrouter: true,  // Use OpenRouter
    });

    console.log('✓ precompute-context: dryRun completed, memories=' + result.memoriesIncluded);
    return true;
  } catch (err) {
    console.log('✗ precompute-context:', err.message);
    return false;
  }
}

// Test 5: session-processor (via daemon)
async function testSessionProcessor() {
  console.log('\n=== Testing session-processor ===');
  try {
    // session-processor is internal, test via its exported functions if any
    // It uses runLLM internally which wraps callLLM
    const { callLLM } = await import('../dist/lib/llm.js');

    // Simulate what session-processor does - extract session summary
    const prompt = `Summarize this coding session in 2 sentences:
User asked about authentication. Assistant implemented JWT tokens with refresh mechanism.`;

    const result = await callLLM(prompt, { timeout: 30000, maxTokens: 200 }, { backend: 'openrouter' });

    if (result && result.length > 10) {
      console.log('✓ session-processor (via callLLM):', result.substring(0, 100).replace(/\n/g, ' ') + '...');
      return true;
    }
    console.log('✗ session-processor: empty result');
    return false;
  } catch (err) {
    console.log('✗ session-processor:', err.message);
    return false;
  }
}

// Test 6: analyzer
async function testAnalyzer() {
  console.log('\n=== Testing analyzer (discovery agent) ===');
  try {
    // analyzer uses callLLM for runDiscoveryAgent
    const { callLLM } = await import('../dist/lib/llm.js');

    // Simulate what analyzer does - analyze code structure
    const prompt = `Analyze this TypeScript function and describe what it does in one sentence:
function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}`;

    const result = await callLLM(prompt, { timeout: 30000, maxTokens: 200 }, { backend: 'openrouter' });

    if (result && result.length > 10) {
      console.log('✓ analyzer (via callLLM):', result.substring(0, 100).replace(/\n/g, ' ') + '...');
      return true;
    }
    console.log('✗ analyzer: empty result');
    return false;
  } catch (err) {
    console.log('✗ analyzer:', err.message);
    return false;
  }
}

// Test 7: service (writeReflection)
async function testService() {
  console.log('\n=== Testing service (reflection) ===');
  try {
    // service uses callLLM for writeReflection
    const { callLLM } = await import('../dist/lib/llm.js');

    // Simulate what service does - generate reflection
    const prompt = `Based on this session summary, write a brief reflection (2-3 sentences):
Session: User implemented authentication with JWT tokens and refresh mechanism.
Key decisions: Used httpOnly cookies for security, 7-day refresh token expiry.`;

    const result = await callLLM(prompt, { timeout: 30000, maxTokens: 300 }, { backend: 'openrouter' });

    if (result && result.length > 10) {
      console.log('✓ service (via callLLM):', result.substring(0, 100).replace(/\n/g, ' ') + '...');
      return true;
    }
    console.log('✗ service: empty result');
    return false;
  } catch (err) {
    console.log('✗ service:', err.message);
    return false;
  }
}

// Run all tests
async function main() {
  console.log('=== Integration Tests for LLM Migration ===');

  const results = {
    compactBriefing: await testCompactBriefing(),
    sessionSummary: await testSessionSummary(),
    consolidate: await testConsolidate(),
    precomputeContext: await testPrecomputeContext(),
    sessionProcessor: await testSessionProcessor(),
    analyzer: await testAnalyzer(),
    service: await testService(),
  };

  console.log('\n=== Summary ===');
  for (const [name, ok] of Object.entries(results)) {
    console.log(`${ok ? '✓' : '✗'} ${name}`);
  }

  const passed = Object.values(results).filter(v => v).length;
  const total = Object.values(results).length;
  console.log(`\n${passed}/${total} tests passed`);

  process.exit(passed === total ? 0 : 1);
}

main().catch(console.error);

import { searchSkyll, getSkyllStatus } from '../dist/lib/skyll-client.js';
import { suggestSkills } from '../dist/lib/skills.js';

console.log('=== Testing shadcn-ui skill discovery ===\n');

// 1. Check Skyll status
console.log('1. Skyll Status:');
const status = getSkyllStatus();
console.log(JSON.stringify(status, null, 2));

// 2. Direct Skyll search for shadcn
console.log('\n2. Direct Skyll search for "shadcn ui":');
const skyllResults = await searchSkyll(['shadcn', 'ui'], { limit: 5, skipCache: true });
console.log('Found ' + skyllResults.length + ' skills:');
for (const skill of skyllResults) {
  const desc = skill.description ? skill.description.slice(0, 60) : 'no description';
  console.log('  - ' + skill.name + ': ' + desc + '...');
}

// 3. Full suggest flow
console.log('\n3. Full suggestSkills flow:');
const suggestions = await suggestSkills('help me add a button component from shadcn ui', {
  auto_suggest: {
    llm_backend: 'openrouter',
    openrouter_model: 'anthropic/claude-3-haiku',
  },
});
console.log('Suggestions: ' + suggestions.length);
for (const s of suggestions) {
  console.log('  - ' + s.name + ' (' + Math.round(s.confidence * 100) + '%): ' + s.reason);
}

console.log('\n4. Final Skyll status:');
console.log(JSON.stringify(getSkyllStatus(), null, 2));

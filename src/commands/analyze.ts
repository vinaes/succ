import spawn from 'cross-spawn';
import fs from 'fs';
import path from 'path';
import ora from 'ora';
import { getProjectRoot, getSuccDir, getLLMTaskConfig } from '../lib/config.js';
import { logError } from '../lib/fault-logger.js';
import {
  loadAnalyzeState, saveAnalyzeState, getGitHead, getChangedFiles,
  hashFile, shouldRerunAgent, type AnalyzeState
} from '../lib/analyze-state.js';

// Import from new modules
import {
  profileProjectWithAST,
  profileProjectWithLLM,
  getDefaultProfile,
  gatherProjectContext,
  type ProjectProfile,
} from './analyze-profile.js';

import {
  getAgents,
  runAgentsParallel,
  runAgentsSequential,
  runAgentsApi,
  createLLMCaller,
  type Agent,
} from './analyze-agents.js';

import {
  sanitizeFilename,
  buildMocContent,
  buildItemPrompt,
  gatherItemContext,
  runMultiPassItems,
  cleanAgentSubfiles,
  ensureBrainStructure,
  generateIndexFiles,
  type MultiPassOptions,
} from './analyze-utils.js';

import {
  analyzeFileRecursive,
  analyzeFile,
  type AnalyzeFileOptions,
  type AnalyzeFileResult,
} from './analyze-recursive.js';

// Re-export public APIs for external consumers
export { analyzeFile, analyzeFileRecursive };
export type { AnalyzeFileOptions, AnalyzeFileResult };

interface AnalyzeOptions {
  parallel?: boolean;
  api?: boolean;
  background?: boolean;
  fast?: boolean;
  force?: boolean;
}

/**
 * Analyze project and generate brain vault using Claude Code agents
 */
export async function analyze(options: AnalyzeOptions = {}): Promise<void> {
  const { parallel = true, api = false, background = false, fast = false } = options;

  // Determine mode from options or config
  const analyzeCfg = getLLMTaskConfig('analyze');
  const mode: 'claude' | 'api' = api ? 'api' : (analyzeCfg.mode as 'claude' | 'api');
  const projectRoot = getProjectRoot();
  const succDir = getSuccDir();
  const brainDir = path.join(succDir, 'brain');

  // Background mode: spawn detached process and exit
  if (background) {
    const logFile = path.join(succDir, 'analyze.log');
    const args = ['analyze'];
    if (!parallel) args.push('--sequential');
    if (mode === 'api') args.push('--api');
    if (fast) args.push('--fast');

    // Spawn detached process
    const child = spawn(process.execPath, [process.argv[1], ...args], {
      detached: true,
      stdio: ['ignore', fs.openSync(logFile, 'w'), fs.openSync(logFile, 'a')],
      cwd: projectRoot,
      windowsHide: true, // Hide CMD window on Windows (works without detached)
    });

    child.unref();

    console.log('🚀 Analysis started in background');
    console.log(`   Log file: ${logFile}`);
    console.log(`   Check progress: succ status`);
    console.log(`   Or view log: succ daemon logs`);
    return;
  }

  // Write progress file
  const progressFile = path.join(succDir, 'analyze.progress.json');
  const writeProgress = (status: string, completed: number, total: number, current?: string) => {
    fs.writeFileSync(progressFile, JSON.stringify({
      status,
      completed,
      total,
      current,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2));
  };

  const backendName = mode === 'api'
    ? `API (${analyzeCfg.model || 'not configured'} @ ${analyzeCfg.api_url})`
    : 'Claude Code CLI';

  console.log('🧠 Analyzing project with Claude agents...\n');
  console.log(`Project: ${projectRoot}`);
  console.log(`Mode: ${parallel ? 'parallel' : 'sequential'}${fast ? ' (fast)' : ''}`);
  console.log(`Backend: ${backendName}`);
  if (fast) console.log(`Fast mode: 5 agents, reduced context`);
  console.log('');

  writeProgress('starting', 0, 4);

  // Ensure brain structure exists
  await ensureBrainStructure(brainDir, projectRoot);

  // Pass 0: Project profiling (AST-first, LLM enrichment optional)
  const profileSpinner = ora('Profiling project...').start();
  let profile: ProjectProfile;
  try {
    // Start with static AST profiling (instant, zero-cost)
    profile = await profileProjectWithAST(projectRoot);
    const astSystems = profile.systems.length;
    const astFeatures = profile.features.length;

    // Enrich with LLM profiling when not in fast mode (better system/feature naming)
    if (!fast && mode === 'api') {
      try {
        const llmProfile = await profileProjectWithLLM(projectRoot, mode, false);
        // Merge: LLM provides better names/descriptions, AST provides accurate structure
        if (llmProfile.systems.length > 0) profile.systems = llmProfile.systems;
        if (llmProfile.features.length > 0) profile.features = llmProfile.features;
        if (llmProfile.entryPoints.length > 0) profile.entryPoints = llmProfile.entryPoints;
        if (llmProfile.keyFiles.length > 0) {
          // Merge key files: LLM picks + AST picks
          profile.keyFiles = [...new Set([...llmProfile.keyFiles, ...profile.keyFiles])];
        }
        profileSpinner.succeed(
          `Profiled (AST+LLM): ${profile.languages.join(', ')} — ${profile.systems.length} systems, ${profile.features.length} features`
        );
      } catch (err) {
        logError('analyze', 'LLM enrichment failed', err instanceof Error ? err : undefined);
        profileSpinner.succeed(
          `Profiled (AST): ${profile.languages.join(', ')} — ${astSystems} systems, ${astFeatures} features`
        );
      }
    } else {
      profileSpinner.succeed(
        `Profiled (AST): ${profile.languages.join(', ')} — ${astSystems} systems, ${astFeatures} features`
      );
    }
  } catch (err) {
    logError('analyze', 'AST profiling failed', err instanceof Error ? err : undefined);
    profile = getDefaultProfile();
    profileSpinner.warn('Profiling failed, using fallback profile');
  }
  console.log('');

  // Define agents (with profile for enriched prompts)
  const projectName = path.basename(projectRoot);
  let agents = getAgents(brainDir, projectName);

  // Incremental analyze: skip agents whose outputs are still fresh
  const currentHead = getGitHead(projectRoot);
  const prevState = options.force ? null : loadAnalyzeState(succDir);

  if (prevState && prevState.gitCommit && currentHead) {
    const changedFiles = getChangedFiles(projectRoot, prevState.gitCommit);
    const skippable = agents.filter(a => !shouldRerunAgent(a.name, prevState, changedFiles));
    const rerun = agents.filter(a => shouldRerunAgent(a.name, prevState, changedFiles));

    if (skippable.length > 0 && rerun.length < agents.length) {
      console.log(`Incremental: skipping ${skippable.length} unchanged agent(s): ${skippable.map(a => a.name).join(', ')}`);
      console.log(`Re-running ${rerun.length} agent(s): ${rerun.map(a => a.name).join(', ')}\n`);
      agents = rerun;
    }

    if (agents.length === 0) {
      console.log('All agents are up to date. Use --force to re-run all.');
      writeProgress('completed', 0, 0);
      return;
    }
  }

  // Pass 1: Gather context using profile
  writeProgress('gathering_context', 0, agents.length, 'Gathering project context');
  const context = await gatherProjectContext(projectRoot, profile, fast);

  // Run single-file agents based on mode
  if (mode === 'api') {
    await runAgentsApi(agents, context, writeProgress, fast);
  } else {
    // Default: Claude Code CLI
    if (parallel) {
      await runAgentsParallel(agents, context);
    } else {
      await runAgentsSequential(agents, context);
    }
  }

  // Multi-pass: individual API calls per system/feature (skipped in fast mode)
  if (!fast && mode !== 'claude' && (profile.systems.length > 0 || profile.features.length > 0)) {
    const concurrency = analyzeCfg.concurrency ?? 3;
    const multiPassMaxTokens = analyzeCfg.max_tokens ?? 8192;
    const callLLM = createLLMCaller(mode, multiPassMaxTokens);
    // Reuse the LLM-guided context already gathered (profile-aware file tree + key files)
    const broadContext = context;
    const projectDir = path.join(brainDir, '01_Projects', projectName);

    // Systems multi-pass
    if (profile.systems.length > 0) {
      const systemsDir = path.join(projectDir, 'Systems');
      const systemsOverviewPath = path.join(systemsDir, 'Systems Overview.md');
      fs.mkdirSync(systemsDir, { recursive: true });
      cleanAgentSubfiles(systemsDir, systemsOverviewPath);

      console.log(`\nSystems documentation (${profile.systems.length} systems, concurrency ${concurrency})...`);
      const sysResults = await runMultiPassItems({
        type: 'systems',
        projectName,
        items: profile.systems,
        callLLM,
        concurrency,
        broadContext,
        projectRoot,
        onProgress: (done, total, name) => {
          writeProgress('running', done, total, `system: ${name}`);
          console.log(`  [${done}/${total}] ${name}`);
        },
      });

      // Write individual system files
      for (const item of sysResults.succeeded) {
        const filePath = path.join(systemsDir, `${item.name}.md`);
        fs.writeFileSync(filePath, item.content, 'utf-8');
      }
      // Write programmatic MOC
      const mocItems = sysResults.succeeded.map(s => {
        const orig = profile.systems.find(p => sanitizeFilename(p.name) === s.name);
        return { name: s.name, description: orig?.description || '', keyFile: orig?.keyFile || '' };
      });
      fs.writeFileSync(systemsOverviewPath, buildMocContent('systems', projectName, mocItems), 'utf-8');

      if (sysResults.failed.length > 0) {
        console.log(`  ⚠ ${sysResults.failed.length} system(s) failed: ${sysResults.failed.map(f => f.name).join(', ')}`);
      }
      console.log(`  ${sysResults.succeeded.length}/${profile.systems.length} systems documented`);
    }

    // Features multi-pass
    if (profile.features.length > 0) {
      const featuresDir = path.join(projectDir, 'Features');
      const featuresOverviewPath = path.join(featuresDir, 'Features Overview.md');
      fs.mkdirSync(featuresDir, { recursive: true });
      cleanAgentSubfiles(featuresDir, featuresOverviewPath);

      console.log(`\nFeatures documentation (${profile.features.length} features, concurrency ${concurrency})...`);
      const featResults = await runMultiPassItems({
        type: 'features',
        projectName,
        items: profile.features,
        callLLM,
        concurrency,
        broadContext,
        projectRoot,
        onProgress: (done, total, name) => {
          writeProgress('running', done, total, `feature: ${name}`);
          console.log(`  [${done}/${total}] ${name}`);
        },
      });

      // Write individual feature files
      for (const item of featResults.succeeded) {
        const filePath = path.join(featuresDir, `${item.name}.md`);
        fs.writeFileSync(filePath, item.content, 'utf-8');
      }
      // Write programmatic MOC
      const mocItems = featResults.succeeded.map(f => {
        const orig = profile.features.find(p => sanitizeFilename(p.name) === f.name);
        return { name: f.name, description: orig?.description || '', keyFile: orig?.keyFile || '' };
      });
      fs.writeFileSync(featuresOverviewPath, buildMocContent('features', projectName, mocItems), 'utf-8');

      if (featResults.failed.length > 0) {
        console.log(`  ⚠ ${featResults.failed.length} feature(s) failed: ${featResults.failed.map(f => f.name).join(', ')}`);
      }
      console.log(`  ${featResults.succeeded.length}/${profile.features.length} features documented`);
    }
  }

  // Update incremental state with multi-pass markers
  const addMultiPassState = (state: AnalyzeState) => {
    if (!fast && (profile.systems.length > 0 || profile.features.length > 0)) {
      state.agents['systems-overview'] = { lastRun: new Date().toISOString(), outputHash: '' };
      state.agents['features'] = { lastRun: new Date().toISOString(), outputHash: '' };
    }
  };

  // Generate index files and save state
  await generateIndexFiles(brainDir, projectName);
  const newState: AnalyzeState = {
    lastRun: new Date().toISOString(),
    gitCommit: currentHead,
    fileCount: 0,
    agents: {},
  };
  if (prevState) {
    Object.assign(newState.agents, prevState.agents);
  }
  for (const agent of agents) {
    newState.agents[agent.name] = {
      lastRun: new Date().toISOString(),
      outputHash: hashFile(agent.outputPath),
    };
  }
  addMultiPassState(newState);
  saveAnalyzeState(succDir, newState);

  console.log('\n✅ Brain vault generated!');
  console.log(`\nNext steps:`);
  console.log(`  1. Review generated docs in .succ/brain/`);
  console.log(`  2. Run \`succ index\` to create embeddings`);
  console.log(`  3. Open in Obsidian for graph view`);
}

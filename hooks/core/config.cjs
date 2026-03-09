#!/usr/bin/env node
/**
 * Shared hook config loader.
 *
 * Loads and merges global (~/.succ/config.json) + project (.succ/config.json)
 * configs. Project values always override global values.
 *
 * CommonJS module, no npm dependencies, only Node.js built-ins.
 *
 * Usage:
 *   const { loadMergedConfig } = require('./core/config.cjs');
 *   const config = loadMergedConfig(projectDir);
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Deep-merge `source` into `target` (one level — nested objects are shallow-merged).
 * Arrays from source replace arrays in target entirely.
 *
 * @param {object} target
 * @param {object} source
 * @returns {object} mutated target
 */
function mergeConfig(target, source) {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (sv !== null && typeof sv === 'object' && !Array.isArray(sv) &&
        tv !== null && typeof tv === 'object' && !Array.isArray(tv)) {
      // Both sides are plain objects — shallow-merge one level deeper
      target[key] = Object.assign({}, tv, sv);
    } else {
      target[key] = sv;
    }
  }
  return target;
}

/**
 * Load and merge global + project configs. Project values override global.
 *
 * Reads:
 *   1. ~/.succ/config.json  (global defaults)
 *   2. <projectDir>/.succ/config.json  (project overrides)
 *
 * Parse errors are silently skipped so the hook stays fail-open.
 *
 * @param {string} projectDir - Absolute path to the project root
 * @returns {object} Merged config (plain object, never null)
 */
function loadMergedConfig(projectDir) {
  const configPaths = [
    path.join(os.homedir(), '.succ', 'config.json'), // global first
    path.join(projectDir, '.succ', 'config.json'),   // project overrides
  ];

  let merged = {};
  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        merged = mergeConfig(merged, raw);
      } catch {
        // intentionally empty — ignore parse errors, stay fail-open
      }
    }
  }
  return merged;
}

module.exports = { loadMergedConfig };

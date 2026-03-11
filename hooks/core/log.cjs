#!/usr/bin/env node
/**
 * Shared hook logging helper.
 *
 * Writes timestamped entries to .succ/.tmp/hooks.log.
 * Fail-open: any I/O error is silently swallowed (logging is never critical).
 *
 * CommonJS module, no npm dependencies, only Node.js built-ins.
 *
 * Usage:
 *   const { log } = require('./core/log.cjs');
 *   log(succDir, 'session-start', 'message here');
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Append a timestamped log entry to .succ/.tmp/hooks.log.
 *
 * @param {string} succDir  - Absolute path to the .succ directory
 * @param {string} hookName - Short hook identifier shown in brackets (e.g. 'session-start')
 * @param {string} message  - Log message
 */
function log(succDir, hookName, message) {
  try {
    const tmpDir = path.join(succDir, '.tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    const logFile = path.join(tmpDir, 'hooks.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] [${hookName}] ${message}\n`);
  } catch {
    // intentionally empty — logging failed, not critical
  }
}

module.exports = { log };

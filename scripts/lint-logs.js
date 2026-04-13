#!/usr/bin/env node
/**
 * CI check: no console.log or console.error allowed in production source.
 * Only console.info and console.warn are permitted (via utils/logger.js).
 * Run: node scripts/lint-logs.js
 */
const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['config', 'controllers', 'middleware', 'routes'].map(d => path.join(ROOT, d));

// Files excluded from the check:
// - oldorder.js, test.js: dead code, not mounted on any route
// - encryption.js: contains "console.log" only inside an error message string literal
const EXCLUDED = ['oldorder.js', 'test.js', 'encryption.js'];

let violations = [];

for (const dir of DIRS) {
  try {
    const result = execSync(
      `grep -rn "console\\.\\(log\\|error\\)" "${dir}" --include="*.js"`,
      { encoding: 'utf8' }
    );
    if (result.trim()) {
      const lines = result.trim().split('\n').filter(line =>
        !EXCLUDED.some(excl => line.includes(excl))
      );
      violations.push(...lines);
    }
  } catch (e) {
    // grep exits non-zero when no matches — that's the success case
    if (e.status !== 1) {
      console.error('grep error:', e.message);
      process.exit(2);
    }
  }
}

if (violations.length > 0) {
  console.error('\n[lint:logs] FAIL — console.log/error found in production source:\n');
  violations.forEach(v => console.error(' ', v));
  console.error('\nUse logger.info / logger.warn / logger.error from utils/logger.js instead.\n');
  process.exit(1);
}

console.info('[lint:logs] PASS — no console.log/error in production source.');
process.exit(0);

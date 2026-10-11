#!/usr/bin/env node
// Checks the test itself: a test that has never been seen failing proves nothing.
// For each rule this script builds a copy of the hook with that rule broken on purpose and
// runs the acceptance test against the copy. The acceptance test MUST fail every time.
// The working hook is never touched.

import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCEPTANCE = join(ROOT, 'test', 'acceptance.mjs');

// [name, file, text that must occur exactly once, replacement that breaks the rule]
const breaks = [
  ['timeout limit raised', 'lib/rules.mjs', 'export const TIMEOUT_MAX_MS = 600_000;', 'export const TIMEOUT_MAX_MS = 60_000_000;'],
  ['normalization removed (multi-line loops invisible again)', 'lib/rules.mjs',
    "return String(command ?? '').replace(/\\s+/g, ' ').trim();", "return String(command ?? '').trim();"],
  ['long single sleep allowed', 'lib/rules.mjs', 'export const SLEEP_MAX_S = 60;', 'export const SLEEP_MAX_S = 6000;'],
  ['second-model rule switched off', 'lib/rules.mjs', "if (/GUARD-OK/.test(c)) {", 'if (true) {'],
  ['BOM check switched off', 'lib/rules.mjs', 'if (firstBytes[0] === 0xEF && firstBytes[1] === 0xBB && firstBytes[2] === 0xBF) {', 'if (false) {'],
  ['block mode downgraded to audit', 'lib/rules.mjs', "timeout: 'block',", "timeout: 'audit',"],
  ['hook no longer fails open', 'guard.mjs', "} catch {\n  // Fail open, deliberately silent", "} catch {\n  process.exit(2);\n  // Fail open, deliberately silent"],
  ['wait loop falsely fires on any sleep', 'lib/rules.mjs', 'if (long && Number(long[1]) >= SLEEP_MAX_S) {', 'if (long) {'],
  ['the first hit wins again, so an audit rule hides a block rule', 'lib/rules.mjs', "return hits.find((v) => v.mode === 'block') ?? hits[0] ?? null;", 'return hits[0] ?? null;'],
];

// Exit code 1 means "the test ran and failed". Anything else (a crash, a timeout, a process that
// never started) is a broken self-check and must not be counted as a detected break.
const ranAndFailed = (r) => !r.error && r.signal === null && r.status === 1;
const ranAndPassed = (r) => !r.error && r.signal === null && r.status === 0;

const run = (hook) => spawnSync(process.execPath, [ACCEPTANCE], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, GUARD_HOOK: hook } });

let bad = 0;
const clean = run(join(ROOT, 'guard.mjs'));
if (!ranAndPassed(clean)) { console.log('FAIL  the untouched hook does not pass its own acceptance test'); bad += 1; } else console.log('ok    untouched hook passes');

for (const [name, file, find, replace] of breaks) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-selfcheck-'));
  cpSync(join(ROOT, 'guard.mjs'), join(dir, 'guard.mjs'));
  cpSync(join(ROOT, 'lib'), join(dir, 'lib'), { recursive: true });
  const path = join(dir, file);
  const src = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const hits = src.split(find).length - 1;
  if (hits !== 1) {
    console.log(`FAIL  ${name}: marker found ${hits} times, expected exactly 1 (dead probe)`);
    bad += 1;
  } else {
    writeFileSync(path, src.replace(find, replace), 'utf8');
    const r = run(join(dir, 'guard.mjs'));
    if (ranAndPassed(r)) { console.log(`FAIL  ${name}: acceptance test stayed green with the rule broken`); bad += 1; }
    else if (!ranAndFailed(r)) { console.log(`FAIL  ${name}: the acceptance test did not run properly (status ${r.status}, signal ${r.signal})`); bad += 1; }
    else console.log(`ok    ${name}: acceptance test turns red`);
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(bad === 0 ? `\nPASSED: the acceptance test catches all ${breaks.length} deliberate breaks` : `\nFAILED: ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);

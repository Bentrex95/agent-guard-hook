#!/usr/bin/env node
// Checks the tests of the completion loop, the time budget and the verify report. Each entry breaks
// one thing in a copy of the repo and runs the matching test file there. The tests MUST fail.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['stop.mjs', 'budget.mjs', 'verify-report.mjs', 'lib', 'test'];
const LOOP = 'loop-and-budget.test.mjs';
const VERIFY = 'verify-report.test.mjs';
const PARTIAL_LINE = "else if (subset || stateChanged || incomplete || notRun.length > 0) status = 'PARTIAL';";

// [name, file, text that must occur exactly once, replacement, test file (default: loop and budget)]
const breaks = [
  ['a running item no longer counts as open', 'lib/checklist.mjs', "const OPEN = new Set(['⬜', '🔄']);", "const OPEN = new Set(['⬜']);"],
  ['a single marked line already counts as a checklist', 'lib/checklist.mjs', 'if (current.length >= 2) runs.push(current);', 'if (current.length >= 1) runs.push(current);'],
  ['all lists of a block are merged again', 'lib/checklist.mjs', "else if (line.trim() !== '') close(); // a blank line may sit inside a list, other text ends it", ''],
  ['the loop ignores stop_hook_active (endless loop)', 'lib/checklist.mjs', 'if (stopHookActive) return null;', ''],
  ['an old checklist from an earlier round still blocks', 'lib/checklist.mjs', "if (e.type === 'user' && isRealInput(e.message?.content)) break;", ''],
  ['the first checklist is used instead of the last', 'lib/checklist.mjs', 'for (let i = texts.length - 1; i >= 0; i--) {\n    const c = checklist(texts[i]);', 'for (let i = 0; i < texts.length; i++) {\n    const c = checklist(texts[i]);'],
  ['stop.mjs no longer fails open', 'stop.mjs', '} catch {\n  // fail open\n}', '} catch {\n  process.stdout.write(JSON.stringify({ decision: \'block\', reason: \'error\' }));\n}'],
  ['a budget is invented when none was stated', 'lib/budget.mjs', 'if (!m) return nowMs != null ? deadlineFrom(text, nowMs) : null;', 'if (!m) return 1200;'],
  ['an unknown unit is read as minutes', 'lib/budget.mjs', 'else return null; // a word that is not a known time unit: no budget', 'else factor = 60;'],
  ['"1 hour" is read as one minute', 'lib/budget.mjs', 'const HOURS = /^(h|hr|hrs|hour|hours)$/;', 'const HOURS = /^(h|hours)$/;'],
  ['hours are read as minutes', 'lib/budget.mjs', 'else if (HOURS.test(unit)) factor = 3600;', 'else if (HOURS.test(unit)) factor = 60;'],
  ['the 80 % warning is gone', 'lib/budget.mjs', "else if (share >= 0.8) z += '. 80 % used: core and verification only.';", ''],
  ['every tool call produces a report (noise)', 'lib/budget.mjs', 'if (lastMs == null || nowMs - lastMs >= gapS * 1000) return { report: true, level };', 'return { report: true, level };'],
  ['sessions share one clock', 'budget.mjs', "const file = join(STATE, `${safe(event.session_id)}__${key}.json`);", "const file = join(STATE, `shared__${key}.json`);"],
  ['a state that changed during the run still counts as verified', 'verify-report.mjs', PARTIAL_LINE, "else if (subset || incomplete || notRun.length > 0) status = 'PARTIAL';", VERIFY],
  ['a subset run can be VERIFIED', 'verify-report.mjs', PARTIAL_LINE, "else if (stateChanged || incomplete || notRun.length > 0) status = 'PARTIAL';", VERIFY],
  ['an incompletely measured state can be VERIFIED', 'verify-report.mjs', PARTIAL_LINE, "else if (subset || stateChanged || notRun.length > 0) status = 'PARTIAL';", VERIFY],
  ['a red step no longer blocks', 'verify-report.mjs', 'for (const s of red) reasons.push(`step red: ${s.name}`);', '', VERIFY],
  ['configuration problems no longer block', 'verify-report.mjs', 'if (problems.length > 0) reasons.push(`configuration problems (${problems.length})`);', '', VERIFY],
  ['a stale report is not noticed', 'verify-report.mjs', 'if (!stored || !currentHash || stored !== currentHash) {', 'if (!stored || !currentHash) {', VERIFY],
  ['a stored status is believed without its evidence', 'verify-report.mjs', 'if (derived.status !== report.status) {', 'if (false) {', VERIFY],
  ['a configuration that is JSON null crashes the run', 'verify-report.mjs', 'const problems = raw?.unreadable ?', 'const problems = raw.unreadable ?', VERIFY],
  ['a step that hit the time limit counts as green', 'verify-report.mjs', 'const green = code === 0 && !timedOut;', 'const green = code === 0 || timedOut;', VERIFY],
  ['steps keep running after a red one', 'verify-report.mjs', "if (r.result === 'red') stopped = `stopped after red in ${s.name}`;", '', VERIFY],
  ['untracked files are not part of the state', 'verify-report.mjs', "for (const k of Object.keys(files).filter((x) => !x.startsWith('diff:')).sort()) h.update(`${k}\\0${files[k]}\\0`);", '', VERIFY],
  ['the report hides what was not checked', 'verify-report.mjs', 'for (const e of r.notChecked) z.push(`  - ${e.what}: ${e.reason} [evidence: ${e.evidence}]`);', '', VERIFY],
];

const run = (dir, testFile = LOOP) => spawnSync(process.execPath, ['--test', join(dir, 'test', testFile)], { encoding: 'utf8', timeout: 180_000 });

// A detected break means: the test file ran ALL its tests and at least one failed. The number of
// tests is taken from the untouched run. A file that cannot start (syntax error, import error,
// a blocked process) is reported by the runner as one failing test, and that must not count.
const count = (r, word) => Number((new RegExp(`^ℹ ${word} (\\d+)`, 'm').exec(r.stdout ?? '') ?? [])[1] ?? -1);
const baseline = { [LOOP]: run(ROOT, LOOP), [VERIFY]: run(ROOT, VERIFY) };
const expected = { [LOOP]: count(baseline[LOOP], 'tests'), [VERIFY]: count(baseline[VERIFY], 'tests') };
const ranAndFailed = (r, testFile) => !r.error && r.signal === null && r.status === 1
  && count(r, 'tests') === expected[testFile] && count(r, 'fail') >= 1;

let bad = 0;
if (baseline[LOOP].status !== 0 || baseline[VERIFY].status !== 0 || expected[LOOP] < 1 || expected[VERIFY] < 1) {
  console.log('FAIL  the untouched source does not pass its tests');
  bad += 1;
} else console.log(`ok    untouched source passes (${expected[LOOP]} + ${expected[VERIFY]} tests)`);

for (const [name, file, find, replace, testFile = LOOP] of breaks) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-selfcheck-loop-'));
  for (const f of FILES) cpSync(join(ROOT, f), join(dir, f), { recursive: true });
  const path = join(dir, file);
  const src = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const hits = src.split(find).length - 1;
  if (hits !== 1) {
    console.log(`FAIL  ${name}: marker found ${hits} times, expected exactly 1 (dead probe)`);
    bad += 1;
  } else {
    writeFileSync(path, src.replace(find, replace), 'utf8');
    const r = run(dir, testFile);
    if (r.status === 0) { console.log(`FAIL  ${name}: tests stayed green with this broken`); bad += 1; }
    else if (!ranAndFailed(r, testFile)) { console.log(`FAIL  ${name}: the tests did not run completely (status ${r.status}, signal ${r.signal}, ${count(r, 'tests')} of ${expected[testFile]} tests)`); bad += 1; }
    else console.log(`ok    ${name}: tests turn red`);
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(bad === 0 ? `\nPASSED: the tests catch all ${breaks.length} deliberate breaks` : `\nFAILED: ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);

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

// [name, file, text that must occur exactly once, replacement, test file (default: loop and budget)]
const breaks = [
  ['a running item no longer counts as open', 'lib/checklist.mjs', "const OPEN = new Set(['⬜', '🔄']);", "const OPEN = new Set(['⬜']);"],
  ['a single marked line already counts as a checklist', 'lib/checklist.mjs', 'if (current.length >= 2) runs.push(current);', 'if (current.length >= 1) runs.push(current);'],
  ['all lists of a block are merged again', 'lib/checklist.mjs', "else if (line.trim() !== '') close(); // a blank line may sit inside a list, other text ends it", ''],
  ['money is read as minutes', 'lib/budget.mjs', 'if (NOT_TIME.test(unit)) return null;', ''],
  ['"1 hour" is read as one minute', 'lib/budget.mjs', 'const HOURS = /^(h|hr|hrs|hour|hours)$/;', 'const HOURS = /^(h|hours)$/;'],
  ['the loop ignores stop_hook_active (endless loop)', 'lib/checklist.mjs', 'if (stopHookActive) return null;', ''],
  ['an old checklist from an earlier round still blocks', 'lib/checklist.mjs', "if (e.type === 'user' && isRealInput(e.message?.content)) break;", ''],
  ['the first checklist is used instead of the last', 'lib/checklist.mjs', 'for (let i = texts.length - 1; i >= 0; i--) {\n    const c = checklist(texts[i]);', 'for (let i = 0; i < texts.length; i++) {\n    const c = checklist(texts[i]);'],
  ['stop.mjs no longer fails open', 'stop.mjs', '} catch {\n  // fail open\n}', '} catch {\n  process.stdout.write(JSON.stringify({ decision: \'block\', reason: \'error\' }));\n}'],
  ['a budget is invented when none was stated', 'lib/budget.mjs', 'if (!m) return nowMs != null ? deadlineFrom(text, nowMs) : null;', 'if (!m) return 1200;'],
  ['hours are read as minutes', 'lib/budget.mjs', 'HOURS.test(unit) ? 3600 : 60;', 'HOURS.test(unit) ? 60 : 60;'],
  ['the 80 % warning is gone', 'lib/budget.mjs', "else if (share >= 0.8) z += '. 80 % used: core and verification only.';", ''],
  ['every tool call produces a report (noise)', 'lib/budget.mjs', 'if (lastMs == null || nowMs - lastMs >= gapS * 1000) return { report: true, level };', 'return { report: true, level };'],
  ['sessions share one clock', 'budget.mjs', "const file = join(STATE, `${safe(event.session_id)}__${key}.json`);", "const file = join(STATE, `shared__${key}.json`);"],
  ['a state that changed during the run still counts as verified', 'verify-report.mjs', "else if (subset || stateChanged || notRun.length > 0) status = 'PARTIAL';", "else if (subset || notRun.length > 0) status = 'PARTIAL';", VERIFY],
  ['a subset run can be VERIFIED', 'verify-report.mjs', "else if (subset || stateChanged || notRun.length > 0) status = 'PARTIAL';", "else if (stateChanged || notRun.length > 0) status = 'PARTIAL';", VERIFY],
  ['a red step no longer blocks', 'verify-report.mjs', 'for (const s of red) reasons.push(`step red: ${s.name}`);', '', VERIFY],
  ['configuration problems no longer block', 'verify-report.mjs', 'if (problems.length > 0) reasons.push(`configuration problems (${problems.length})`);', '', VERIFY],
  ['a stale report is not noticed', 'verify-report.mjs', 'if (!stored || !currentHash || stored !== currentHash) {', 'if (!stored || !currentHash) {', VERIFY],
  ['a step that hit the time limit counts as green', 'verify-report.mjs', 'const green = code === 0 && !timedOut;', 'const green = code === 0 || timedOut;', VERIFY],
  ['steps keep running after a red one', 'verify-report.mjs', "if (r.result === 'red') stopped = `stopped after red in ${s.name}`;", '', VERIFY],
  ['untracked files are not part of the state', 'verify-report.mjs', "for (const k of Object.keys(files).filter((x) => !x.startsWith('diff:')).sort()) h.update(`${k}\\0${files[k]}\\0`);", '', VERIFY],
  ['the report hides what was not checked', 'verify-report.mjs', 'for (const e of r.notChecked) z.push(`  - ${e.what}: ${e.reason} [evidence: ${e.evidence}]`);', '', VERIFY],
];

const run = (dir, testFile = LOOP) => spawnSync(process.execPath, ['--test', join(dir, 'test', testFile)], { encoding: 'utf8', timeout: 180_000 });

// Exit code 1 means "the tests ran and at least one failed". A crash or timeout is not a detected break.
const ranAndFailed = (r) => !r.error && r.signal === null && r.status === 1 && /^ℹ fail [1-9]/m.test(r.stdout ?? '');

let bad = 0;
if (run(ROOT).status !== 0 || run(ROOT, VERIFY).status !== 0) { console.log('FAIL  the untouched source does not pass its tests'); bad += 1; } else console.log('ok    untouched source passes');

for (const [name, file, find, replace, testFile] of breaks) {
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
    else if (!ranAndFailed(r)) { console.log(`FAIL  ${name}: the tests did not run properly (status ${r.status}, signal ${r.signal})`); bad += 1; }
    else console.log(`ok    ${name}: tests turn red`);
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(bad === 0 ? `\nPASSED: the tests catch all ${breaks.length} deliberate breaks` : `\nFAILED: ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);

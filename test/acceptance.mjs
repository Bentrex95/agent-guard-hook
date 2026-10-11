#!/usr/bin/env node
// Acceptance test for the guard hook. Two batteries, both must pass:
//
//   A) NORMAL: legitimate calls must GO THROUGH. Without this battery the hook must not be
//      armed: a false positive blocks real work, and that costs more than the rule is worth.
//   B) SABOTAGE: every case the hook exists to stop must be DETECTED.
//
// The normal cases are not invented examples but commands in the shape they really occur,
// including multi-line scripts, loops without sleep and commands that merely mention "sleep".
//
// The test runs the real hook as a child process with the same JSON a tool call produces.
// GUARD_HOOK points the test at a copy of the hook (see test/selfcheck.mjs).

import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = process.env.GUARD_HOOK || join(HERE, '..', 'guard.mjs');
const tmp = join(tmpdir(), `guard-test-${process.pid}`);
mkdirSync(tmp, { recursive: true });
// Own audit log for the test: test runs must not end up in a real audit trail.
const LOG = join(tmp, 'audit.jsonl');

function call(payload) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, GUARD_AUDIT_LOG: LOG, GUARD_OFF: '' },
  });
  return { code: r.status, err: (r.stderr ?? '').trim() };
}
const before = (tool, input) => call({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input });
const logged = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// ---------------------------------------------------------------- A) NORMAL
const normal = [
  ['simple command', 'Bash', { command: 'git status --porcelain' }],
  ['timeout exactly at the limit', 'Bash', { command: 'npm test', timeout: 600000 }],
  ['timeout well below', 'Bash', { command: 'npm test', timeout: 120000 }],
  ['loop WITHOUT sleep', 'Bash', { command: 'for f in *.json; do echo "$f"; done' }],
  ['multi-line loop without sleep', 'Bash', { command: 'for f in *.md\ndo\n  wc -l "$f"\ndone' }],
  ['the word "do" in prose plus a short sleep', 'Bash', { command: 'echo "things to do"; sleep 1' }],
  ['searching for the word sleep', 'Bash', { command: 'grep -rn "sleep 5" .' }],
  ['short single sleep', 'Bash', { command: 'sleep 2' }],
  ['wait loop, but in the BACKGROUND', 'Bash', { command: 'until curl -s localhost:3001/health; do sleep 3; done', run_in_background: true }],
  ['while read without sleep', 'Bash', { command: 'cat list.txt | while read z; do echo "$z"; done' }],
  ['PowerShell without sleep', 'PowerShell', { command: 'Get-ChildItem | Measure-Object' }],
  ['PowerShell short Start-Sleep, no loop', 'PowerShell', { command: 'Start-Sleep -Seconds 2; Get-Date' }],
  ['other tool, high timeout irrelevant', 'Read', { file_path: 'C:\\x.txt', timeout: 9999999 }],
  ['empty input', 'Bash', {}],
  ['npm command with semicolons', 'Bash', { command: 'npm run build; if [ $? -eq 0 ]; then npm test; fi' }],
  ['git command with for loop and pipe', 'Bash', { command: 'for r in $(git remote); do git remote show "$r" | head -3; done' }],
  ['codex WITHOUT sandbox switch', 'Bash', { command: 'codex exec "review this file"' }],
  ['codex unsandboxed, explicitly marked', 'Bash', { command: 'codex --sandbox danger-full-access exec "implement X"  # GUARD-OK' }],
  ['the word codex in prose', 'Bash', { command: 'grep -rn "danger-full-access" ~/.claude/skills' }],
];

// ---------------------------------------------------------------- B) SABOTAGE
// expected: 'block' = exit code 2, 'audit' = goes through but must appear in the audit log
const sabotage = [
  ['timeout above 600000', 'Bash', { command: 'npm test', timeout: 600001 }, 'timeout'],
  ['absurdly high timeout', 'Bash', { command: 'npm test', timeout: 3600000 }, 'timeout'],
  ['one-line until loop', 'Bash', { command: 'until test -f done.txt; do sleep 5; done' }, 'waitloop'],
  ['MULTI-LINE until loop (the old checker was blind here)', 'Bash', {
    command: 'until curl -s localhost:3001/health > /dev/null\ndo\n  sleep 3\ndone\necho up',
  }, 'waitloop'],
  ['multi-line while loop with indentation', 'Bash', {
    command: 'while [ ! -f out.log ]\ndo\n    sleep 10\n    echo waiting\ndone',
  }, 'waitloop'],
  ['for loop with sleep', 'Bash', { command: 'for i in $(seq 60); do sleep 5; curl -s x; done' }, 'waitloop'],
  ['PowerShell wait loop, multi-line', 'PowerShell', {
    command: 'while (-not (Test-Path "done.txt")) {\n  Start-Sleep -Seconds 5\n}',
  }, 'waitloop'],
  ['PowerShell do-until with Start-Sleep', 'PowerShell', {
    command: 'do {\n  $r = Invoke-WebRequest x\n  Start-Sleep 5\n} until ($r.StatusCode -eq 200)',
  }, 'waitloop'],
  ['long single sleep', 'Bash', { command: 'sleep 300' }, 'waitloop'],
  ['long Start-Sleep', 'PowerShell', { command: 'Start-Sleep -Seconds 120' }, 'waitloop'],
  ['codex unsandboxed', 'Bash', { command: 'codex --sandbox danger-full-access exec "review this repo"' }, 'secondmodel'],
  ['codex unsandboxed INSIDE a worktree (no exception)', 'Bash', { command: 'cd /c/Temp/wt-1 && codex --sandbox danger-full-access exec "fix"' }, 'secondmodel'],
  ['codex with bypass switch', 'Bash', { command: 'codex --dangerously-bypass-approvals-and-sandbox exec "check"' }, 'secondmodel'],
];
const MODE = { timeout: 'block', secondmodel: 'block', waitloop: 'audit', bom: 'block' };

let failures = 0;
const fail = (msg) => { failures += 1; console.log(`  FAIL  ${msg}`); };

console.log('A) NORMAL: must go through and leave no audit entry');
for (const [name, tool, input] of normal) {
  const n = logged().length;
  const r = before(tool, input);
  if (r.code !== 0) fail(`${name}: rejected (${r.err})`);
  else if (logged().length !== n) fail(`${name}: went through but was logged as a violation`);
  else console.log(`  ok    ${name}`);
}

console.log('B) SABOTAGE: must be blocked, or logged for audit rules');
for (const [name, tool, input, rule] of sabotage) {
  const n = logged().length;
  const r = before(tool, input);
  const entry = logged().slice(n).find((e) => e.rule === rule);
  if (MODE[rule] === 'block' && r.code !== 2) fail(`${name}: not blocked (exit ${r.code})`);
  else if (MODE[rule] === 'block' && !r.err.includes(`GUARD (${rule})`)) fail(`${name}: blocked without the reason for rule ${rule}`);
  else if (MODE[rule] === 'audit' && r.code !== 0) fail(`${name}: audit rule must not block (exit ${r.code})`);
  else if (!entry) fail(`${name}: no audit entry for rule ${rule}`);
  else console.log(`  ok    ${name} -> ${MODE[rule]}`);
}

console.log('C) BOM: file written with a BOM must be flagged after the write');
const withBom = join(tmp, 'with-bom.json');
const noBom = join(tmp, 'no-bom.json');
writeFileSync(withBom, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('{}')]));
writeFileSync(noBom, '{}');
const after = (path) => call({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path } });
if (after(withBom).code !== 2) fail('file with BOM not flagged'); else console.log('  ok    file with BOM -> block');
if (after(noBom).code !== 0) fail('file without BOM flagged'); else console.log('  ok    file without BOM goes through');

console.log('D) FAIL OPEN: broken input and the kill switch must let the call through');
const broken = spawnSync(process.execPath, [HOOK], { input: '{not json', encoding: 'utf8', timeout: 20_000 });
if (broken.status !== 0) fail('broken JSON did not fail open'); else console.log('  ok    broken JSON -> exit 0');
const off = spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test', timeout: 9_000_000 } }),
  encoding: 'utf8', timeout: 20_000, env: { ...process.env, GUARD_OFF: '1' },
});
if (off.status !== 0) fail('kill switch GUARD_OFF=1 did not let the call through'); else console.log('  ok    GUARD_OFF=1 -> exit 0');

rmSync(tmp, { recursive: true, force: true });
const total = normal.length + sabotage.length + 4;
console.log(failures === 0 ? `\nPASSED: ${total} cases` : `\nFAILED: ${failures} of ${total} cases`);
process.exit(failures === 0 ? 0 : 1);

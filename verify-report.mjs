#!/usr/bin/env node
// Machine-written final report for a project's verification run.
//
// An agent that says "done, all tests pass" is summarizing. This script runs the steps of the
// project's verification one by one, measures exit code and duration, stops at the first red
// step, measures the state of the repository (HEAD + working tree) before AND after the run and
// derives exactly one status from that:
//   VERIFIED  all steps green, state unchanged during the run            -> exit 0
//   BLOCKED   a step is red, or the configuration is invalid             -> exit 1
//   PARTIAL   a subset (--only) or the state changed during the run      -> exit 1
//   STALE     (--check only) the stored report does not match the state  -> exit 2
// The block between "=== VERIFY REPORT ===" and "=== END ===" is meant to be quoted verbatim.
// "Done" is then a quote from a run, not a sentence the agent wrote.
//
// Usage (in the project root, or with --root <dir>):
//   node verify-report.mjs                 full run
//   node verify-report.mjs --only <step>   only this step (repeatable) -> at most PARTIAL
//   node verify-report.mjs --check         compare the stored report with the current state
//
// Configuration: verify.config.json in the project root
//   { "steps": [{ "name": "test", "command": "npm test" }],
//     "scope": ["src", "test"],
//     "notChecked": [{ "what": "...", "reason": "...", "evidence": "..." }] }
// `notChecked` is the maintained list of what this run does NOT prove. It is printed in every
// report, so a green status cannot be read as more than it is.
//
// Deriving the status and all formatting are pure functions (exported, tested in
// test/verify-report.test.mjs).

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

export const EXIT = { VERIFIED: 0, BLOCKED: 1, PARTIAL: 1, STALE: 2, 'NO-REPORT': 2 };

// ---------------------------------------------------------------------------------------------
// Pure functions

/** Checks the configuration. Returns a list of problems; any problem means BLOCKED. */
export function configProblems(config) {
  const problems = [];
  if (!config || typeof config !== 'object') return ['verify.config.json is not an object'];
  if (!Array.isArray(config.steps) || config.steps.length === 0) problems.push('no steps configured: nothing would be checked');
  const seen = new Set();
  for (const [i, s] of (Array.isArray(config.steps) ? config.steps : []).entries()) {
    if (!s || typeof s.name !== 'string' || !s.name.trim()) problems.push(`step ${i + 1}: name missing`);
    else if (seen.has(s.name)) problems.push(`step name used twice: ${s.name}`);
    else seen.add(s.name);
    if (!s || typeof s.command !== 'string' || !s.command.trim()) problems.push(`step ${i + 1}: command missing`);
  }
  if (config.scope !== undefined && (!Array.isArray(config.scope) || config.scope.some((p) => typeof p !== 'string' || !p))) problems.push('scope must be a list of paths');
  if (config.notChecked !== undefined) {
    if (!Array.isArray(config.notChecked)) problems.push('notChecked must be a list');
    else config.notChecked.forEach((e, i) => {
      for (const field of ['what', 'reason', 'evidence']) {
        if (!e || typeof e[field] !== 'string' || e[field].trim() === '') problems.push(`notChecked entry ${i + 1}: field "${field}" missing or empty`);
      }
    });
  }
  return problems;
}

/**
 * Derives the status of a run.
 * @param {object} e
 * @param {string[]} e.problems   configuration problems
 * @param {{name:string, result:'green'|'red'|'not-run'}[]} e.steps  all configured steps
 * @param {boolean} e.subset      --only was given
 * @param {string} e.stateBefore  state hash before the run
 * @param {string} e.stateAfter   state hash after the run
 * @returns {{status:'VERIFIED'|'BLOCKED'|'PARTIAL', exitCode:number, reasons:string[]}}
 */
export function deriveStatus({ problems = [], steps = [], subset = false, stateBefore, stateAfter }) {
  const reasons = [];
  const red = steps.filter((s) => s.result === 'red');
  const notRun = steps.filter((s) => s.result === 'not-run');
  const unknown = steps.filter((s) => !['green', 'red', 'not-run'].includes(s.result));
  const stateChanged = !stateBefore || !stateAfter || stateBefore !== stateAfter;

  if (problems.length > 0) reasons.push(`configuration problems (${problems.length})`);
  for (const s of red) reasons.push(`step red: ${s.name}`);
  for (const s of unknown) reasons.push(`step without a valid result: ${s.name}`);
  if (steps.length === 0) reasons.push('no steps: nothing checked');
  const blocked = reasons.length > 0;

  if (subset) reasons.push('subset (--only)');
  if (stateChanged) reasons.push('state changed during the run (or could not be measured)');
  if (!blocked && !subset && notRun.length > 0) reasons.push(`not run: ${notRun.map((s) => s.name).join(', ')}`);

  let status;
  if (blocked) status = 'BLOCKED';
  else if (subset || stateChanged || notRun.length > 0) status = 'PARTIAL';
  else status = 'VERIFIED';
  return { status, exitCode: EXIT[status], reasons };
}

/** Names what changed between two state measurements (empty = nothing). */
export function stateDifference(before, after) {
  const out = [];
  if (!before || !after) return ['state could not be measured'];
  if (before.head !== after.head) out.push(`HEAD ${String(before.head).slice(0, 12)} -> ${String(after.head).slice(0, 12)}`);
  const a = before.files ?? {}, b = after.files ?? {};
  for (const k of Object.keys({ ...a, ...b }).sort()) {
    if (!(k in a)) out.push(`added ${k}`);
    else if (!(k in b)) out.push(`gone ${k}`);
    else if (a[k] !== b[k]) out.push(`changed ${k}`);
  }
  if (out.length === 0 && before.hash !== after.hash) out.push('state hash differs, cause could not be attributed');
  return out;
}

/** Checks a stored report against the current state. */
export function checkStored(report, currentHash) {
  if (!report || typeof report !== 'object' || !report.state || typeof report.status !== 'string') {
    return { status: 'NO-REPORT', exitCode: EXIT['NO-REPORT'], reason: 'no readable report (.verify-report.json)' };
  }
  const stored = report.state.after?.hash;
  if (!stored || !currentHash || stored !== currentHash) {
    return { status: 'STALE', exitCode: EXIT.STALE, reason: `state ${short(currentHash)} differs from the report's ${short(stored)}` };
  }
  return { status: report.status, exitCode: report.status === 'VERIFIED' ? 0 : 1, reason: 'state unchanged since the report' };
}

const short = (h) => (typeof h === 'string' ? h.slice(0, 12) : '(missing)');
const sec = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** Formats the block that is meant to be quoted. */
export function formatReport(r) {
  const z = [];
  z.push('=== VERIFY REPORT ===');
  z.push(`Time:      ${r.begin} to ${r.end} (${sec(r.durationMs)})`);
  z.push(`Mode:      ${r.subset ? `subset --only ${r.only.join(', ')}` : 'full run'}`);
  const b = r.state.before, a = r.state.after;
  z.push(`State:     HEAD ${b.head.slice(0, 12)} (${b.branch}), state hash ${short(b.hash)}, working tree ${b.clean ? 'without' : 'with'} diff against HEAD, ${b.untracked} untracked file(s) in scope`);
  z.push(`           after the run: state hash ${short(a.hash)} -> ${b.hash === a.hash ? 'unchanged' : 'CHANGED'}`);
  const green = r.steps.filter((s) => s.result === 'green');
  z.push(`Passed (${green.length}/${r.steps.length}):`);
  if (green.length === 0) z.push('  (none)');
  for (const s of green) z.push(`  [OK]  ${s.name.padEnd(16)} ${sec(s.durationMs).padStart(9)}  exit 0`);
  z.push('Not checked:');
  const notRun = r.steps.filter((s) => s.result === 'not-run');
  for (const s of notRun) z.push(`  - not run: ${s.name}${s.reason ? ` (${s.reason})` : ''}`);
  for (const e of r.notChecked) z.push(`  - ${e.what}: ${e.reason} [evidence: ${e.evidence}]`);
  if (notRun.length === 0 && r.notChecked.length === 0) z.push('  (nothing)');
  z.push('Open:');
  const open = [];
  for (const p of r.problems) open.push(`CONFIG: ${p}`);
  for (const s of r.steps.filter((x) => x.result === 'red')) {
    open.push(`RED: ${s.name} (exit ${s.exitCode}, ${sec(s.durationMs)}), last lines of output:`);
    for (const l of s.outputTail) open.push(`    | ${l}`);
  }
  for (const reason of r.reasons) if (!reason.startsWith('step red') && !reason.startsWith('configuration problems')) open.push(reason);
  for (const u of r.stateChange ?? []) open.push(`state change: ${u}`);
  if (open.length === 0) z.push('  (nothing)');
  for (const o of open) z.push(o.startsWith('    |') ? o : `  - ${o}`);
  z.push(`Status: ${r.status}`);
  z.push('=== END ===');
  return z.join('\n');
}

export function parseArgs(argv, stepNames = null) {
  const only = [];
  let check = false;
  let root = null;
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') check = true;
    else if (a === '--root') { root = argv[++i]; if (!root) errors.push('--root needs a directory'); }
    else if (a === '--only') {
      const n = argv[++i];
      if (!n) errors.push('--only needs a step name');
      else if (stepNames && !stepNames.includes(n)) errors.push(`unknown step "${n}" (known: ${stepNames.join(', ')})`);
      else only.push(n);
    } else errors.push(`unknown argument "${a}"`);
  }
  if (check && only.length > 0) errors.push('--check and --only exclude each other');
  return { only, check, root, errors };
}

// ---------------------------------------------------------------------------------------------
// Side effects: measure the state, run the steps, write the file

/** State = HEAD + sha256(git diff HEAD) + content of untracked, not ignored files in scope. */
export function measureState(root, scope) {
  const git = (args) => execFileSync('git', args, { cwd: root, maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const head = git(['rev-parse', 'HEAD']).toString().trim();
  let branch = '(detached)';
  try { branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).toString().trim(); } catch { /* stays detached */ }
  const diff = git(['-c', 'core.quotepath=off', 'diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff']);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...(scope.length ? scope : ['.'])]).toString().split('\0').filter(Boolean).sort();
  // A partial hash per file, so that a changed state can say WHAT changed.
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const files = {};
  const diffText = diff.toString('latin1');
  const starts = [...diffText.matchAll(/^diff --git a\/(.*?) b\//gm)];
  starts.forEach((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : diffText.length;
    files[`diff:${m[1]}`] = sha(Buffer.from(diffText.slice(m.index, end), 'latin1'));
  });
  for (const p of untracked) {
    let content;
    try { content = readFileSync(join(root, p)); } catch { content = Buffer.from('(unreadable)'); }
    files[`new:${p}`] = sha(content);
  }
  const h = createHash('sha256');
  h.update(`head\0${head}\0`);
  h.update('diff\0'); h.update(diff); h.update('\0');
  for (const k of Object.keys(files).filter((x) => !x.startsWith('diff:')).sort()) h.update(`${k}\0${files[k]}\0`);
  return { head, branch, hash: h.digest('hex'), clean: diff.length === 0, untracked: untracked.length, files };
}

// Time limit per step (default 15 min, override with VERIFY_STEP_TIMEOUT_MS). A hanging step is
// ended with its WHOLE process tree and counts as red: on Windows a plain kill only ends the
// shell, the children keep running and keep the pipes open.
function killTree(p) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    else p.kill('SIGKILL');
  } catch { /* best effort */ }
}

function runStep(step, root, limitMs, quiet) {
  return new Promise((res) => {
    const t0 = performance.now();
    const lines = [];
    let rest = '';
    let timedOut = false;
    const note = (d) => {
      rest += d.toString();
      const parts = rest.split(/\r?\n/);
      rest = parts.pop();
      for (const t of parts) { lines.push(t); if (lines.length > 25) lines.shift(); }
    };
    const p = spawn(step.command, { cwd: root, shell: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const alarm = setTimeout(() => { timedOut = true; killTree(p); }, limitMs);
    p.stdout.on('data', (d) => { if (!quiet) process.stdout.write(d); note(d); });
    p.stderr.on('data', (d) => { if (!quiet) process.stderr.write(d); note(d); });
    p.on('error', (err) => { lines.push(`spawn error: ${err.message}`); });
    p.on('close', (code, signal) => {
      clearTimeout(alarm);
      if (rest) lines.push(rest);
      const durationMs = performance.now() - t0;
      if (timedOut) lines.push(`TIME LIMIT: stopped after ${Math.round(limitMs / 1000)} s, process tree ended`);
      const green = code === 0 && !timedOut;
      res({ name: step.name, command: step.command, exitCode: timedOut ? 'time limit' : (code ?? `signal ${signal}`), result: green ? 'green' : 'red', durationMs, outputTail: green ? [] : lines.slice(-15) });
    });
  });
}

function readConfig(root) {
  try { return JSON.parse(readFileSync(join(root, 'verify.config.json'), 'utf8')); } catch (e) { return { unreadable: e.message }; }
}

async function run(root, only, quiet) {
  const beginMs = Date.now();
  const raw = readConfig(root);
  const problems = raw.unreadable ? [`verify.config.json unreadable: ${raw.unreadable}`] : configProblems(raw);
  const config = problems.length === 0 ? raw : { steps: Array.isArray(raw?.steps) ? raw.steps.filter((s) => s && typeof s.name === 'string' && typeof s.command === 'string') : [] };
  const scope = Array.isArray(config.scope) ? config.scope : [];
  const limitMs = Number(process.env.VERIFY_STEP_TIMEOUT_MS ?? 15 * 60 * 1000);
  const before = measureState(root, scope);

  const subset = only.length > 0;
  const results = [];
  let stopped = problems.length > 0 ? 'configuration problems, no step started' : null;
  for (const s of config.steps ?? []) {
    if (subset && !only.includes(s.name)) { results.push({ name: s.name, command: s.command, result: 'not-run', reason: 'not in --only' }); continue; }
    if (stopped) { results.push({ name: s.name, command: s.command, result: 'not-run', reason: stopped }); continue; }
    if (!quiet) console.log(`\n[verify-report] >>> ${s.name}: ${s.command}`);
    const r = await runStep(s, root, limitMs, quiet);
    if (!quiet) console.log(`[verify-report] <<< ${s.name}: exit ${r.exitCode} after ${sec(r.durationMs)}`);
    results.push(r);
    if (r.result === 'red') stopped = `stopped after red in ${s.name}`;
  }
  const after = measureState(root, scope);
  const { status, exitCode, reasons } = deriveStatus({ problems, steps: results, subset, stateBefore: before.hash, stateAfter: after.hash });
  const endMs = Date.now();
  const report = {
    format: 1,
    begin: new Date(beginMs).toISOString(), end: new Date(endMs).toISOString(), durationMs: endMs - beginMs,
    subset, only,
    state: { before, after },
    steps: results, problems, notChecked: problems.length === 0 ? (config.notChecked ?? []) : [], reasons, status, exitCode,
    stateChange: stateDifference(before, after),
  };
  report.block = formatReport(report);
  // The report file must be ignored by git (.gitignore), otherwise writing it would change the state it describes.
  writeFileSync(join(root, '.verify-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('\n' + report.block);
  return exitCode;
}

function check(root) {
  const file = join(root, '.verify-report.json');
  let report = null;
  if (existsSync(file)) { try { report = JSON.parse(readFileSync(file, 'utf8')); } catch { report = null; } }
  const raw = readConfig(root);
  const current = measureState(root, Array.isArray(raw?.scope) ? raw.scope : []);
  const r = checkStored(report, current.hash);
  if (report?.block) console.log(report.block);
  if (r.status === 'STALE' && report?.state?.after) for (const u of stateDifference(report.state.after, current)) console.log(`  since the report: ${u}`);
  console.log(`\n[verify-report --check] ${r.status}: ${r.reason} (report from ${report?.end ?? '-'}, HEAD now ${current.head.slice(0, 12)})`);
  return r.exitCode;
}

// Run only as a program, not when the tests import it. Compared through resolved file paths; a
// comparison of URL strings fails on Windows because of drive letters and casing.
const asProgram = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (asProgram) {
  const first = parseArgs(process.argv.slice(2));
  const root = resolve(first.root ?? process.cwd());
  const raw = readConfig(root);
  const names = Array.isArray(raw?.steps) ? raw.steps.map((s) => s?.name).filter(Boolean) : null;
  const { only, check: checkMode, errors } = parseArgs(process.argv.slice(2), names);
  if (errors.length > 0) {
    for (const f of errors) console.error(`[verify-report] ${f}`);
    process.exit(64);
  }
  process.exitCode = checkMode ? check(root) : await run(root, only, process.env.VERIFY_QUIET === '1');
}

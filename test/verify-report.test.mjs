// Tests for verify-report.mjs: the pure status logic, and the program itself run in a small
// temporary git repository.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkStored, configProblems, deriveStatus, formatReport, parseArgs, stateDifference } from '../verify-report.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'verify-report.mjs');
const green = (name) => ({ name, result: 'green' });
const red = (name) => ({ name, result: 'red' });
const notRun = (name) => ({ name, result: 'not-run' });

test('VERIFIED needs every step green and an unchanged state', () => {
  assert.equal(deriveStatus({ steps: [green('a'), green('b')], stateBefore: 'x', stateAfter: 'x' }).status, 'VERIFIED');
  assert.equal(deriveStatus({ steps: [green('a'), green('b')], stateBefore: 'x', stateAfter: 'y' }).status, 'PARTIAL');
  assert.equal(deriveStatus({ steps: [green('a')], stateBefore: undefined, stateAfter: 'y' }).status, 'PARTIAL', 'a state that could not be measured is not verified');
});

test('a red step, a config problem, no steps or an unknown result block', () => {
  assert.equal(deriveStatus({ steps: [green('a'), red('b'), notRun('c')], stateBefore: 'x', stateAfter: 'x' }).status, 'BLOCKED');
  assert.equal(deriveStatus({ problems: ['p'], steps: [notRun('a')], stateBefore: 'x', stateAfter: 'x' }).status, 'BLOCKED');
  assert.equal(deriveStatus({ steps: [], stateBefore: 'x', stateAfter: 'x' }).status, 'BLOCKED');
  assert.equal(deriveStatus({ steps: [{ name: 'a', result: 'maybe' }], stateBefore: 'x', stateAfter: 'x' }).status, 'BLOCKED');
});

test('a subset or a step that did not run is at most PARTIAL, and red beats partial', () => {
  assert.equal(deriveStatus({ steps: [green('a'), notRun('b')], subset: true, stateBefore: 'x', stateAfter: 'x' }).status, 'PARTIAL');
  assert.equal(deriveStatus({ steps: [green('a'), notRun('b')], stateBefore: 'x', stateAfter: 'x' }).status, 'PARTIAL');
  assert.equal(deriveStatus({ steps: [red('a')], subset: true, stateBefore: 'x', stateAfter: 'x' }).status, 'BLOCKED');
  assert.equal(deriveStatus({ steps: [green('a')], subset: true, stateBefore: 'x', stateAfter: 'x' }).exitCode, 1);
});

test('the configuration is checked', () => {
  assert.deepEqual(configProblems({ steps: [{ name: 't', command: 'npm test' }] }), []);
  assert.ok(configProblems({ steps: [] }).length > 0);
  assert.ok(configProblems({ steps: [{ name: 't', command: 'a' }, { name: 't', command: 'b' }] }).some((p) => /twice/.test(p)));
  assert.ok(configProblems({ steps: [{ name: 't' }] }).some((p) => /command/.test(p)));
  assert.ok(configProblems({ steps: [{ name: 't', command: 'a' }], notChecked: [{ what: 'x', reason: '' , evidence: 'e' }] }).some((p) => /reason/.test(p)));
});

test('a file that could not be read keeps the run from being VERIFIED', () => {
  const r = deriveStatus({ steps: [green('a')], stateBefore: 'x', stateAfter: 'x', unmeasured: ['locked.bin'] });
  assert.equal(r.status, 'PARTIAL');
  assert.ok(r.reasons.some((x) => /locked\.bin/.test(x)));
});

// A stored report as the program writes it: all green, state unchanged.
const stored = (over = {}) => ({
  status: 'VERIFIED', subset: false, problems: [], steps: [green('a'), green('b')],
  state: { before: { hash: 'abc', unreadable: [] }, after: { hash: 'abc', unreadable: [] } }, ...over,
});

test('a stored report is stale as soon as the state differs', () => {
  assert.deepEqual([checkStored(stored(), 'abc').status, checkStored(stored(), 'abc').exitCode], ['VERIFIED', 0]);
  assert.deepEqual([checkStored(stored(), 'def').status, checkStored(stored(), 'def').exitCode], ['STALE', 2]);
  assert.equal(checkStored(stored({ status: 'PARTIAL', subset: true }), 'abc').exitCode, 1);
  assert.equal(checkStored(null, 'abc').status, 'NO-REPORT');
});

test('a stored status that does not follow from the stored evidence is rejected', () => {
  const invalid = (r) => assert.deepEqual([checkStored(r, 'abc').status, checkStored(r, 'abc').exitCode], ['INVALID', 2]);
  invalid(stored({ steps: [green('a'), red('b')] }));                 // says VERIFIED, has a red step
  invalid(stored({ subset: true }));                                   // says VERIFIED, was a subset
  invalid(stored({ problems: ['bad config'] }));                       // says VERIFIED, had config problems
  invalid(stored({ state: { before: { hash: 'old' }, after: { hash: 'abc' } } })); // state changed during the run
  invalid(stored({ steps: undefined }));                               // evidence missing
  invalid(stored({ problems: undefined }));
  invalid({ status: 'VERIFIED', state: { after: { hash: 'abc' } } });  // nothing but a claim
  invalid(stored({ status: 'PARTIAL' }));                              // a worse status than the evidence gives is wrong too
});

test('a state difference names the files', () => {
  const a = { head: 'h1', hash: '1', files: { 'new:a.txt': 'x', 'diff:b.txt': 'y' } };
  const b = { head: 'h1', hash: '2', files: { 'new:a.txt': 'z', 'new:c.txt': 'q' } };
  assert.deepEqual(stateDifference(a, b), ['changed new:a.txt', 'gone diff:b.txt', 'added new:c.txt'].sort((x, y) => x.split(' ')[1].localeCompare(y.split(' ')[1])));
  assert.deepEqual(stateDifference(a, a), []);
});

test('the quoted block shows what was not checked', () => {
  const state = { head: 'a'.repeat(40), branch: 'main', hash: 'b'.repeat(64), clean: true, untracked: 0 };
  const block = formatReport({
    begin: 't0', end: 't1', durationMs: 1200, subset: false, only: [], state: { before: state, after: state },
    steps: [{ name: 'unit', result: 'green', durationMs: 1000 }], problems: [], reasons: [], status: 'VERIFIED',
    notChecked: [{ what: 'bundle content', reason: 'the build step only checks that the build succeeds', evidence: 'verify.config.json' }],
  });
  assert.match(block, /^=== VERIFY REPORT ===/);
  assert.match(block, /Not checked:\n {2}- bundle content: the build step only checks/);
  assert.match(block, /Status: VERIFIED\n=== END ===$/);
});

test('arguments', () => {
  assert.deepEqual(parseArgs(['--only', 'a', '--only', 'b'], ['a', 'b']).only, ['a', 'b']);
  assert.ok(parseArgs(['--only', 'x'], ['a']).errors.length > 0);
  assert.ok(parseArgs(['--check', '--only', 'a'], ['a']).errors.length > 0);
  assert.ok(parseArgs(['--wat']).errors.length > 0);
});

// ---- the program in a temporary repository ----------------------------------------------------
const NODE = JSON.stringify(process.execPath);
function repo(config) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-report-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, '.gitignore'), '.verify-report.json\n');
  writeFileSync(join(dir, 'verify.config.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'ok.mjs'), 'process.exit(0);\n');
  writeFileSync(join(dir, 'fail.mjs'), 'console.log("boom: expected 2, got 3"); process.exit(1);\n');
  writeFileSync(join(dir, 'hang.mjs'), 'setInterval(() => {}, 1000);\n');
  writeFileSync(join(dir, 'litter.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync("left-behind.txt", String(Date.now()));\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}
const run = (dir, args = [], env = {}) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', dir, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, VERIFY_QUIET: '1', ...env } });
  return { code: r.status, out: r.stdout ?? '' };
};
const step = (name, file) => ({ name, command: `${NODE} ${file}` });

test('program: all green gives VERIFIED and exit 0, and --check agrees until a file changes', () => {
  const dir = repo({ steps: [step('one', 'ok.mjs'), step('two', 'ok.mjs')] });
  try {
    const r = run(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Passed \(2\/2\)/);
    assert.match(r.out, /Status: VERIFIED/);
    assert.equal(run(dir, ['--check']).code, 0);
    writeFileSync(join(dir, 'ok.mjs'), 'process.exit(0); // edited after the report\n');
    const stale = run(dir, ['--check']);
    assert.equal(stale.code, 2);
    assert.match(stale.out, /STALE/);
    assert.match(stale.out, /since the report: .*ok\.mjs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('program: a red step gives BLOCKED, shows its output and stops the steps after it', () => {
  const dir = repo({ steps: [step('one', 'ok.mjs'), step('two', 'fail.mjs'), step('three', 'ok.mjs')] });
  try {
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /Status: BLOCKED/);
    assert.match(r.out, /RED: two \(exit 1/);
    assert.match(r.out, /\| boom: expected 2, got 3/);
    assert.match(r.out, /not run: three \(stopped after red in two\)/);
    assert.equal(JSON.parse(readFileSync(join(dir, '.verify-report.json'), 'utf8')).status, 'BLOCKED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('program: --only gives PARTIAL even when the step is green', () => {
  const dir = repo({ steps: [step('one', 'ok.mjs'), step('two', 'ok.mjs')] });
  try {
    const r = run(dir, ['--only', 'one']);
    assert.equal(r.code, 1);
    assert.match(r.out, /Status: PARTIAL/);
    assert.match(r.out, /not run: two \(not in --only\)/);
    assert.equal(run(dir, ['--only', 'nope']).code, 64);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('program: a step that changes the working tree gives PARTIAL and names the file', () => {
  const dir = repo({ steps: [step('litter', 'litter.mjs')] });
  try {
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /Status: PARTIAL/);
    assert.match(r.out, /state change: added new:left-behind\.txt/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('program: a hanging step is ended at the time limit and counts as red', () => {
  const dir = repo({ steps: [step('hang', 'hang.mjs'), step('after', 'ok.mjs')] });
  try {
    const t0 = Date.now();
    const r = run(dir, [], { VERIFY_STEP_TIMEOUT_MS: '1500' });
    assert.equal(r.code, 1);
    assert.match(r.out, /RED: hang \(exit time limit/);
    assert.match(r.out, /TIME LIMIT: stopped after 2 s/);
    assert.ok(Date.now() - t0 < 30_000, 'the run must end soon after the limit, not hang on open pipes');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('program: --check does not accept a report whose status was edited', () => {
  const dir = repo({ steps: [step('one', 'ok.mjs'), step('two', 'fail.mjs')] });
  try {
    assert.equal(run(dir).code, 1);
    const file = join(dir, '.verify-report.json');
    const report = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(report.status, 'BLOCKED');
    writeFileSync(file, JSON.stringify({ ...report, status: 'VERIFIED', block: report.block.replace('Status: BLOCKED', 'Status: VERIFIED') }));
    const r = run(dir, ['--check']);
    assert.equal(r.code, 2);
    assert.match(r.out, /INVALID: stored status VERIFIED does not follow from the stored evidence, which gives BLOCKED/);
    assert.doesNotMatch(r.out, /Status: VERIFIED/, 'the forged block must not be printed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('program: a configuration that is valid JSON but not an object blocks instead of crashing', () => {
  const dir = repo(null);
  try {
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /Status: BLOCKED/);
    assert.match(r.out, /CONFIG: verify\.config\.json is not an object/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('program: a broken configuration blocks before any step starts', () => {
  const dir = repo({ steps: [step('one', 'ok.mjs')], notChecked: [{ what: 'x' }] });
  try {
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /Status: BLOCKED/);
    assert.match(r.out, /CONFIG: notChecked entry 1: field "reason" missing or empty/);
    assert.match(r.out, /not run: one \(configuration problems, no step started\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

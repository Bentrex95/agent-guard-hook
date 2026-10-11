// Tests for the completion loop (stop.mjs) and the time budget (budget.mjs).
// The hooks are run as child processes with the JSON a real event carries.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { budgetFrom, deadlineFrom, line, shouldReport } from '../lib/budget.mjs';
import { checklist, verdict } from '../lib/checklist.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (script, payload, env = {}) => {
  const r = spawnSync(process.execPath, [join(ROOT, script)], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, GUARD_OFF: '', ...env },
  });
  return { code: r.status, out: (r.stdout ?? '').trim() };
};

function transcript(dir, lines) {
  const p = join(dir, 'transcript.jsonl');
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}
const user = (text) => ({ type: 'user', message: { content: text } });
const toolResult = () => ({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
const assistant = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

const OPEN_LIST = 'Progress\n✅ step one, done (test output)\n🔄 step two, running\n⬜ step three, open';
const CLOSED_LIST = 'Progress\n✅ step one, done (test output)\n❌ step two, blocked: needs a key\n⏸ step three, waiting for the background run';

test('a checklist needs at least two marked lines; boxes count too', () => {
  assert.equal(checklist('✅ only one line'), null);
  assert.equal(checklist('just text'), null);
  assert.deepEqual(checklist('- [x] a\n- [ ] b\n- [~] c').map((i) => i.mark), ['✅', '⬜', '🔄']);
  assert.equal(checklist('> ✅ quoted\n> ⬜ quoted'), null, 'a quoted list from someone else must not count');
});

test('two lists in one block: the later one counts', () => {
  const updated = '- [ ] A\n- [ ] B\n\nLater in the same message, the update:\n\n- [x] A\n- [x] B';
  assert.deepEqual(checklist(updated).map((i) => i.mark), ['✅', '✅']);
  assert.equal(verdict({ texts: [updated], stopHookActive: false }), null);
  const reopened = '- [x] A\n- [x] B\n\nOn second thought:\n\n- [x] A\n- [ ] B';
  assert.equal(verdict({ texts: [reopened], stopHookActive: false }).open.length, 1);
  assert.deepEqual(checklist('✅ a\n\n⬜ b').map((i) => i.mark), ['✅', '⬜'], 'a blank line inside a list does not split it');
});

test('units: singular and plural, and a number that is not a time', () => {
  assert.equal(budgetFrom('Budget: 1 hour', null), 3600);
  assert.equal(budgetFrom('Budget: 2 hours', null), 7200);
  assert.equal(budgetFrom('Budget: 1 minute', null), 60);
  assert.equal(budgetFrom('Budget: 45 seconds', null), 45);
  assert.equal(budgetFrom('Budget: 500 dollars', null), null);
  assert.equal(budgetFrom('budget: 2 $', null), null);
  assert.equal(budgetFrom('Budget: 30 please be quick', null), 1800, 'an ordinary next word leaves the default unit');
});

test('open items block the end of the turn and are named in the reason', () => {
  const v = verdict({ texts: [OPEN_LIST], stopHookActive: false });
  assert.equal(v.open.length, 2);
  assert.match(v.reason, /2 open item/);
  assert.match(v.reason, /step two, running/);
});

test('done, failed and waiting are allowed end states', () => {
  assert.equal(verdict({ texts: [CLOSED_LIST], stopHookActive: false }), null);
});

test('only the last checklist counts, and stop_hook_active ends the loop', () => {
  assert.equal(verdict({ texts: [OPEN_LIST, CLOSED_LIST], stopHookActive: false }), null);
  assert.ok(verdict({ texts: [CLOSED_LIST, OPEN_LIST], stopHookActive: false }));
  assert.equal(verdict({ texts: [OPEN_LIST], stopHookActive: true }), null);
});

test('stop.mjs blocks on an open checklist in the current round', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-stop-'));
  try {
    const p = transcript(dir, [user('do the thing'), assistant('working'), toolResult(), assistant(OPEN_LIST)]);
    const r = run('stop.mjs', { hook_event_name: 'Stop', transcript_path: p });
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).decision, 'block');
    assert.equal(run('stop.mjs', { hook_event_name: 'Stop', transcript_path: p, stop_hook_active: true }).out, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stop.mjs ignores a checklist from an earlier round', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-stop-'));
  try {
    const p = transcript(dir, [user('first task'), assistant(OPEN_LIST), user('never mind, new question'), assistant('Here is the answer.')]);
    assert.equal(run('stop.mjs', { hook_event_name: 'Stop', transcript_path: p }).out, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stop.mjs fails open: missing transcript, broken JSON, kill switch', () => {
  assert.deepEqual(run('stop.mjs', { hook_event_name: 'Stop', transcript_path: 'Z:/does/not/exist.jsonl' }), { code: 0, out: '' });
  assert.deepEqual(run('stop.mjs', '{not json'), { code: 0, out: '' });
  const dir = mkdtempSync(join(tmpdir(), 'guard-stop-'));
  try {
    const p = transcript(dir, [user('x'), assistant(OPEN_LIST)]);
    assert.equal(run('stop.mjs', { hook_event_name: 'Stop', transcript_path: p }, { GUARD_OFF: '1' }).out, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a budget exists only when it is stated', () => {
  assert.equal(budgetFrom('please fix the bug', null), null);
  assert.equal(budgetFrom('Budget: 30 min', null), 1800);
  assert.equal(budgetFrom('time budget = 45', null), 2700);
  assert.equal(budgetFrom('budget: 90 s', null), 90);
  assert.equal(budgetFrom('budget: 1.5 h', null), 5400);
  assert.equal(budgetFrom('budget: 0 min', null), null);
});

test('a deadline is turned into seconds, and a past time means tomorrow', () => {
  const noon = new Date(2026, 0, 15, 12, 0, 0).getTime();
  assert.equal(deadlineFrom('finish until 12:30', noon), 1800);
  assert.equal(deadlineFrom('done by 11:00 please', noon), 23 * 3600);
  assert.equal(deadlineFrom('run until 3 tests pass', noon), null);
});

test('the line warns at 80 % and at 100 %', () => {
  assert.equal(line(420, null), 'Elapsed: 420s');
  assert.equal(line(420, 1200), 'Elapsed: 420s / 1200s (35 %)');
  assert.match(line(960, 1200), /80 % used/);
  assert.match(line(1300, 1200), /Budget exceeded/);
});

test('reports are spaced out, but a crossed threshold reports at once', () => {
  const base = { startMs: 0, budgetS: 1000, lastMs: 100_000, lastLevel: 0 };
  assert.equal(shouldReport({ nowMs: 120_000, ...base }).report, false);
  assert.equal(shouldReport({ nowMs: 161_000, ...base }).report, true);
  assert.deepEqual(shouldReport({ nowMs: 800_000, ...base, lastMs: 799_000 }), { report: true, level: 1 });
  assert.equal(shouldReport({ nowMs: 801_000, ...base, lastMs: 800_000, lastLevel: 1 }).report, false);
});

test('budget.mjs keeps time per session across calls', () => {
  const state = mkdtempSync(join(tmpdir(), 'guard-time-'));
  try {
    const t0 = 1_800_000_000_000;
    const env = (ms) => ({ GUARD_STATE_DIR: state, GUARD_NOW: String(ms) });
    const first = run('budget.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'Budget: 10 min. Build it.' }, env(t0));
    assert.match(JSON.parse(first.out).hookSpecificOutput.additionalContext, /^Elapsed: 0s \/ 600s/);
    assert.equal(run('budget.mjs', { hook_event_name: 'PostToolUse', session_id: 's1' }, env(t0 + 20_000)).out, '', 'too early for another report');
    const later = run('budget.mjs', { hook_event_name: 'PostToolUse', session_id: 's1' }, env(t0 + 500_000));
    assert.match(JSON.parse(later.out).hookSpecificOutput.additionalContext, /Elapsed: 500s \/ 600s \(83 %\).*80 % used/);
    const other = run('budget.mjs', { hook_event_name: 'PostToolUse', session_id: 's2' }, env(t0 + 500_000));
    assert.equal(JSON.parse(other.out).hookSpecificOutput.additionalContext, 'Elapsed: 0s', 'another session has its own clock and no budget');
  } finally { rmSync(state, { recursive: true, force: true }); }
});

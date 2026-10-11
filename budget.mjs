#!/usr/bin/env node
// UserPromptSubmit + PostToolUse hook: mirrors "Elapsed: 420s / 1200s" into the agent's context,
// separately for the main session (per prompt) and each subagent. Logic in lib/budget.mjs.
// Fail open, kill switch GUARD_OFF=1. State: one small JSON file per session and agent.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { budgetFrom, line, shouldReport } from './lib/budget.mjs';

const STATE = process.env.GUARD_STATE_DIR || join(tmpdir(), 'agent-guard-hook', 'time');
const safe = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
const read = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const write = (p, o) => { try { writeFileSync(p, JSON.stringify(o), 'utf8'); } catch { /* ignore */ } };
const say = (event, text) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));

try {
  if (process.env.GUARD_OFF === '1') process.exit(0);
  const chunks = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const name = String(event.hook_event_name ?? '');
  // GUARD_NOW lets a test set the clock instead of waiting for it.
  const now = process.env.GUARD_NOW ? Number(process.env.GUARD_NOW) : Date.now();
  mkdirSync(STATE, { recursive: true });

  if (name === 'UserPromptSubmit') {
    const file = join(STATE, `${safe(event.session_id)}__main.json`);
    const budgetS = budgetFrom(event.prompt, now);
    const z = { startMs: now, budgetS, lastMs: now, lastLevel: 0 };
    write(file, z);
    if (z.budgetS) say(name, line(0, z.budgetS));
  } else if (name === 'PostToolUse') {
    const key = event.agent_id ? safe(event.agent_id) : 'main';
    const file = join(STATE, `${safe(event.session_id)}__${key}.json`);
    let z = read(file) ?? { startMs: now, budgetS: null, lastMs: null, lastLevel: 0 };
    const { report, level } = shouldReport({ nowMs: now, ...z });
    if (report) {
      say(name, line((now - z.startMs) / 1000, z.budgetS));
      z = { ...z, lastMs: now, lastLevel: level };
    }
    write(file, z);
  }
} catch {
  // fail open
}
process.exit(0);

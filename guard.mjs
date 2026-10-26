#!/usr/bin/env node
// Guard hook for Claude Code (PreToolUse / PostToolUse): rejects tool calls that break rules
// which can be checked deterministically. It replaces finding a violation afterwards with
// preventing it.
//
// IRON RULE: fail open. Every unexpected error in this program ends with exit code 0, so the
// call goes through. A broken hook must never stop real work; it is worth less than the
// work it protects. Kill switch: environment variable GUARD_OFF=1.
//
// Blocking happens through stderr + exit code 2, the documented blocking path; the reason
// shows up in the transcript. A hint goes to stdout as `additionalContext` WITHOUT a
// permissionDecision, so the call stays in the normal permission flow and the model reads the
// reason next to the tool result.

import { openSync, readSync, closeSync, appendFileSync, writeSync } from 'node:fs';
import { checkBefore, checkBom, MODE } from './lib/rules.mjs';

const OFF = process.env.GUARD_OFF === '1';
// Optional audit trail. Tests point it at their own file so test runs never count as real use.
const AUDIT_LOG = process.env.GUARD_AUDIT_LOG || '';

function firstBytes(path, n = 3) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const b = Buffer.allocUnsafe(n);
    const read = readSync(fd, b, 0, n, 0);
    return b.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

// In `audit` mode the call continues and the violation is logged. That is shadow operation:
// first measure how often a pattern rule fires and whether it is right, then harden it.
// A pattern that is switched to blocking immediately is a bet on one's own completeness.
// `hint` is audit plus a message to the agent. Neither mode ends the hook: an earlier version
// exited right after logging, so any rule checked later in the same call was skipped.
const hints = [];
function handle(v) {
  if (AUDIT_LOG) {
    try {
      appendFileSync(AUDIT_LOG, JSON.stringify({
        at: new Date().toISOString(), rule: v.rule, mode: v.mode, reason: v.reason.slice(0, 200),
      }) + '\n', 'utf8');
    } catch { /* the log must never get in the way */ }
  }
  if (v.mode === 'block') {
    process.stderr.write(`GUARD (${v.rule}): ${v.reason}\n`);
    process.exit(2);
  }
  // audit and hint: let it through. The hint is printed once all rules are checked.
  if (v.mode === 'hint') hints.push(`GUARD-HINT (${v.rule}): ${v.reason}`);
}

try {
  if (OFF) {
    process.exit(0);
  }
  const chunks = [];
  for await (const c of process.stdin) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    if (chunks.reduce((s, x) => s + x.length, 0) > 4 * 1024 * 1024) break;
  }
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const name = String(event.hook_event_name ?? '');
  const tool = String(event.tool_name ?? '');
  const input = event.tool_input ?? {};

  if (name === 'PreToolUse') {
    const v = checkBefore(tool, input);
    if (v) handle(v);
    // No rule blocked: pass the collected hints to the model.
    // Synchronous write: process.stdout to a pipe can be asynchronous, and process.exit right after
    // it could cut the JSON short.
    if (hints.length) {
      writeSync(1, JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: hints.join('\n') },
      }));
      process.exit(0);
    }
  } else if (name === 'PostToolUse' && (tool === 'Write' || tool === 'Edit')) {
    const path = input.file_path;
    if (typeof path === 'string') {
      const v = checkBom(path, firstBytes(path));
      // The write has happened; this is only about making it VISIBLE.
      if (v) handle({ ...v, mode: MODE[v.rule] ?? 'audit' });
    }
  }
} catch {
  // Fail open, deliberately silent: a hook error is no reason to refuse the call.
}
process.exit(0);

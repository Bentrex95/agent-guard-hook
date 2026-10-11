#!/usr/bin/env node
// Stop / SubagentStop hook: the completion loop. Logic in lib/checklist.mjs.
// Fail open: every error ends with exit code 0, so the turn may end. Kill switch GUARD_OFF=1.
// Known limit: it does not fire when the user interrupts.

import { openSync, readSync, fstatSync, closeSync, existsSync } from 'node:fs';
import { textBlocksOfRound, verdict } from './lib/checklist.mjs';

const MAX_BYTES = 3 * 1024 * 1024;

// Only the tail of the transcript is read; long sessions grow to hundreds of megabytes.
function readTail(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const n = Math.min(size, MAX_BYTES);
    const b = Buffer.allocUnsafe(n);
    readSync(fd, b, 0, n, size - n);
    const lines = b.toString('utf8').split('\n');
    if (n < size) lines.shift(); // the first line is cut off
    const out = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch { /* skip a broken line */ }
    }
    return out;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

try {
  if (process.env.GUARD_OFF === '1') process.exit(0);
  const chunks = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const path = typeof event.transcript_path === 'string' ? event.transcript_path : null;
  if (!path || !existsSync(path)) process.exit(0);
  const v = verdict({ texts: textBlocksOfRound(readTail(path)), stopHookActive: event.stop_hook_active === true });
  if (v) process.stdout.write(JSON.stringify({ decision: 'block', reason: v.reason }));
} catch {
  // fail open
}
process.exit(0);

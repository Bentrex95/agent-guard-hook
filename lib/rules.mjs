// Guard rules: the parts of my working rules that can be checked deterministically.
//
// WHY CODE AND NOT PROSE: these rules sat in my agent instructions for months and were
// still broken repeatedly. A rule that can be enforced deterministically does not belong
// in a prompt. The checker I had before reported violations AFTER the fact, which is
// bookkeeping, not prevention.
//
// THE BLIND SPOT THIS VERSION FIXES: the old checker used `[^\n]{0,400}?` and therefore
// could not find a wait loop that spans several lines. Its own counter-test had the same
// flaw because it generated its cases on one line, so the gap could not be found by design.
// Here the command is normalized FIRST (all line breaks and indentation become single
// spaces); after that a plain `.` window is enough.

export const TIMEOUT_MAX_MS = 600_000;
export const SLEEP_MAX_S = 60;

export function normalize(command) {
  return String(command ?? '').replace(/\s+/g, ' ').trim();
}

// --- Rule 1: timeout above 600000 ms ------------------------------------------------------
// Measured: anything above is silently capped and the command is killed at 600 s with exit
// code 143. The wait condition is then unmet and the round was wasted.
export function checkTimeout(tool, input) {
  const t = input?.timeout;
  if (typeof t === 'number' && t > TIMEOUT_MAX_MS) {
    return {
      rule: 'timeout',
      reason: `timeout=${t} ms is above the limit of ${TIMEOUT_MAX_MS} ms. Anything above is `
        + 'silently capped and the command is killed at 600 s with exit code 143, so the wait '
        + 'condition stays unmet. A command that runs longer belongs in run_in_background.',
    };
  }
  return null;
}

// --- Rule 2: wait loop in the foreground --------------------------------------------------
const SLEEP_BASH = String.raw`(?:^|[;&|(\s])sleep\s+[\d.]`;
const SLEEP_PS = String.raw`Start-Sleep\b`;

// Requires real loop SYNTAX, not just the word. `echo "things to do"; sleep 1` must not
// trigger, so `do` alone is no trigger; it only counts after while/until/for.
const LOOP_BASH = new RegExp(
  String.raw`\b(?:while|until|for)\b.{0,200}?\bdo\b.{0,400}?` + SLEEP_BASH, 'i',
);
const LOOP_PS = new RegExp(
  String.raw`\b(?:while|until|for|foreach|do)\b.{0,300}?` + SLEEP_PS, 'i',
);

export function checkWaitLoop(tool, input) {
  // In the background a loop is explicitly allowed; it blocks nobody there.
  if (input?.run_in_background === true) {
    return null;
  }
  const raw = input?.command;
  if (typeof raw !== 'string' || !raw) {
    return null;
  }
  const c = normalize(raw);

  if (LOOP_BASH.test(c) || LOOP_PS.test(c)) {
    return {
      rule: 'waitloop',
      reason: 'Wait loop in the foreground (loop with sleep/Start-Sleep). One event expected: '
        + 'run_in_background with a command that ends by itself when the condition is met. '
        + 'Measured on the same work: 130.2 s blocked versus under 1 s.',
    };
  }

  // A single long sleep is the same mistake without the loop.
  const long = c.match(/(?:^|[;&|(\s])sleep\s+(\d+(?:\.\d+)?)/i)
    ?? c.match(/Start-Sleep\s+(?:-Seconds\s+)?(\d+(?:\.\d+)?)/i);
  if (long && Number(long[1]) >= SLEEP_MAX_S) {
    return {
      rule: 'waitloop',
      reason: `Single sleep of ${long[1]} s in the foreground (limit ${SLEEP_MAX_S} s). `
        + 'Waiting belongs in the background, not in the turn.',
    };
  }
  return null;
}

// --- Rule 3: second model with write access to the working tree ---------------------------
// My review briefs said "read-only" in prose. Technically the reviewing model ran with
// danger-full-access, so with write access to everything. A promise in a brief is not a
// mechanism, and the review is exactly where the separation of builder and reviewer either
// holds or does not.
//
// Deliberately NOT an absolute ban: the second model may still implement. Only the
// unsandboxed call without an explicit marker is rejected. Override with the word GUARD-OK
// in the command; then the decision was made on purpose and is visible in the transcript.
const CODEX_OPEN = /--dangerously-bypass-approvals-and-sandbox|(?:--sandbox|-s)\s+danger-full-access|danger-full-access/i;

export function checkSecondModel(tool, input) {
  const raw = input?.command;
  if (typeof raw !== 'string' || !raw) {
    return null;
  }
  const c = normalize(raw);
  if (!/\bcodex\b/i.test(c) || !CODEX_OPEN.test(c)) {
    return null;
  }
  if (/GUARD-OK/.test(c)) {
    return null;
  }
  // NO exception for git worktrees. The first version let the call through when a worktree
  // path appeared in the command. That was theater: a process with danger-full-access writes
  // everywhere regardless of its working directory. A worktree separates files and branches;
  // it is not a permission boundary.
  return {
    rule: 'secondmodel',
    reason: 'Codex call without sandbox (danger-full-access). For a review, write access is not '
      + 'just unnecessary, it removes the separation of builder and reviewer. Run it sandboxed, '
      + 'or mark the call with GUARD-OK if write access is intended.',
  };
}

// --- Rule 4: BOM in files that silently break on it ---------------------------------------
// Measured on Windows PowerShell 5.1: `-Encoding utf8` writes WITH a BOM, for Out-File and
// Set-Content. A `.bat` with a BOM breaks silently. This can only be checked after the
// write; it cannot be prevented because the write has already happened.
export const BOM_EXTENSIONS = ['.bat', '.cmd', '.ps1', '.json', '.mjs', '.js', '.ts', '.cjs'];

export function checkBom(path, firstBytes) {
  if (typeof path !== 'string' || !firstBytes || firstBytes.length < 3) {
    return null;
  }
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (!BOM_EXTENSIONS.includes(ext)) {
    return null;
  }
  if (firstBytes[0] === 0xEF && firstBytes[1] === 0xBB && firstBytes[2] === 0xBF) {
    return {
      rule: 'bom',
      reason: `${path} starts with a UTF-8 BOM (EF BB BF). Windows PowerShell 5.1 writes one with `
        + '"-Encoding utf8". Write BOM-free with [IO.File]::WriteAllText and UTF8Encoding($false).',
    };
  }
  return null;
}

// --- Application --------------------------------------------------------------------------
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// Mode PER RULE, not global. Not every rule can be detected with the same certainty, and a
// false positive costs real work.
//
//   block = the call is rejected. Only for rules that work on a STRUCTURED field or whose
//           detection does not depend on text patterns.
//   audit = the call runs and the violation is logged. For rules whose detection is a
//           pattern and therefore has unknown blind spots.
//
// The wait-loop rule stays on `audit` although its test catches every case I wrote: a
// pattern recognizes exactly the shapes one thought of. The predecessor failed on multi-line
// loops; this version finds them, but other shell syntax, nested quotes or encoded commands
// are untested. Blocking hard would repeat the same design mistake with a better pattern.
export const MODE = {
  timeout: 'block',      // structured field, no pattern, no grey zone
  secondmodel: 'block',  // placeholder until real isolation exists
  bom: 'block',          // only fires AFTER the write anyway
  waitloop: 'audit',
};

export function checkBefore(tool, input) {
  if (!SHELL_TOOLS.has(tool)) {
    return null;
  }
  // Every rule is evaluated and a blocking rule wins. The first version stopped at the first hit,
  // so `sleep 60; codex --sandbox danger-full-access ...` was only logged as a wait loop and the
  // unsandboxed call went through: an audit rule was hiding a block rule.
  const hits = [checkTimeout(tool, input), checkWaitLoop(tool, input), checkSecondModel(tool, input)]
    .filter(Boolean)
    .map((v) => ({ ...v, mode: MODE[v.rule] ?? 'audit' }));
  return hits.find((v) => v.mode === 'block') ?? hits[0] ?? null;
}

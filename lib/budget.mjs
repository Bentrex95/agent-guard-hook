// Time budget in the agent's context: "Elapsed: 420s / 1200s". Pure functions.
// A budget exists ONLY when one was stated ("Budget: 30 min" in the prompt or in a subagent
// brief). No invented total: without a statement the line is just "Elapsed: 420s".

// The word after the number is captured whatever it is, so that "Budget: 500 dollars" can be told
// apart from "Budget: 30" (no unit, minutes are meant).
const BUDGET = /(?:time\s*)?budget\s*[:=]\s*(\d+(?:[.,]\d+)?)[ \t]*([a-z%$€]+)?/i;
const SECONDS = /^(s|sec|secs|second|seconds)$/;
const MINUTES = /^(m|min|mins|minute|minutes)$/;
const HOURS = /^(h|hr|hrs|hour|hours)$/;
// Units that mean the number is not a time at all. Any other following word is just the next word of the sentence.
const NOT_TIME = /^(dollars?|usd|eur|euros?|\$|€|%|percent|tokens?|k|calls?|requests?|files?|lines?)$/;

// Deadline "until 20:30" or "by 20:30" -> seconds from nowMs (local time of the machine).
// If the time has already passed today, the next day is meant.
const DEADLINE = /\b(?:until|by)\s+(2[0-3]|[01]?\d):([0-5]\d)\b/i;

export function deadlineFrom(text, nowMs) {
  const m = String(text ?? '').match(DEADLINE);
  if (!m) return null;
  const target = new Date(nowMs);
  target.setHours(Number(m[1]), Number(m[2]), 0, 0);
  let ms = target.getTime() - nowMs;
  if (ms <= 0) ms += 24 * 3600 * 1000;
  return Math.round(ms / 1000);
}

export function budgetFrom(text, nowMs) {
  const m = String(text ?? '').match(BUDGET);
  if (!m) return nowMs != null ? deadlineFrom(text, nowMs) : null;
  const number = Number(m[1].replace(',', '.'));
  const unit = (m[2] ?? '').toLowerCase();
  if (NOT_TIME.test(unit)) return null;
  const factor = SECONDS.test(unit) ? 1 : HOURS.test(unit) ? 3600 : 60;
  const s = Math.round(number * factor);
  return s > 0 ? s : null;
}

export function line(elapsedS, budgetS) {
  const e = Math.max(0, Math.round(elapsedS));
  if (!budgetS) return `Elapsed: ${e}s`;
  const share = e / budgetS;
  let z = `Elapsed: ${e}s / ${budgetS}s (${Math.round(share * 100)} %)`;
  if (share >= 1) z += '. Budget exceeded: finish and verify the core, drop the polish, report the rest as open.';
  else if (share >= 0.8) z += '. 80 % used: core and verification only.';
  return z;
}

// Report when at least 60 s have passed since the last report or a budget threshold (80 %,
// 100 %) was newly crossed. Otherwise stay silent; one line per tool call would be noise.
export function shouldReport({ nowMs, startMs, budgetS, lastMs, lastLevel }, gapS = 60) {
  const level = levelOf((nowMs - startMs) / 1000, budgetS);
  if (level > (lastLevel ?? 0)) return { report: true, level };
  if (lastMs == null || nowMs - lastMs >= gapS * 1000) return { report: true, level };
  return { report: false, level };
}

function levelOf(elapsedS, budgetS) {
  if (!budgetS) return 0;
  const a = elapsedS / budgetS;
  return a >= 1 ? 2 : a >= 0.8 ? 1 : 0;
}

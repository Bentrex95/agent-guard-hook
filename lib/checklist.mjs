// Completion loop: the end of a turn is not the end of a task. Pure functions, no file or
// process access; the wrapper stop.mjs reads the transcript.
//
// Rule: if the last checklist of the current round still has an open item (⬜ or 🔄), the end
// of the turn is rejected ONCE and the open items are handed back as the next instruction.
// Allowed end states per item: ✅ (with evidence), ❌ (reason or blocker), ⏸ (waiting for a
// named background run or for the user). No checklist in the round: no intervention.
// stop_hook_active: no intervention (prevents endless loops).

const MARK = /^\s*(?:[-*]\s*)?(✅|⬜|🔄|❌|⏸️?)\s*(.*)$/u;
// Markdown boxes as subagents keep them in progress files: [ ] open, [~] running, [x] done.
const BOX = /^\s*[-*]\s*\[([ xX~])\]\s*(.*)$/u;
const BOX_MARK = { ' ': '⬜', '~': '🔄', x: '✅', X: '✅' };
const OPEN = new Set(['⬜', '🔄']);

// Transcript lines (already parsed JSON objects) -> text blocks of the current round.
// A round starts after the last real user input (text, not a tool result).
export function textBlocksOfRound(entries) {
  const texts = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'user' && isRealInput(e.message?.content)) break;
    if (e.type === 'assistant') {
      const content = e.message?.content;
      if (Array.isArray(content)) {
        for (let k = content.length - 1; k >= 0; k--) {
          if (content[k]?.type === 'text' && typeof content[k].text === 'string') texts.unshift(content[k].text);
        }
      } else if (typeof content === 'string') {
        texts.unshift(content);
      }
    }
  }
  return texts;
}

function isRealInput(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b?.type === 'text') && !content.some((b) => b?.type === 'tool_result');
}

// A checklist is at least two marked lines in the same block. Quoted lines ("> ...") do not
// count because both patterns are anchored at the start of the line. A separate filter for
// quotes turned out to be dead code: breaking it on purpose left the test green.
//
// One text block can hold several lists, for example an early list and its update further down.
// Marked lines are therefore grouped into runs of neighbouring lines, and the LAST run of at
// least two lines is the checklist. Merging all runs made an old open list block a finished one.
export function checklist(text) {
  const runs = [];
  let current = [];
  const close = () => { if (current.length >= 2) runs.push(current); current = []; };
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(MARK);
    const k = m ? null : line.match(BOX);
    if (m) current.push({ mark: m[1].replace('️', ''), text: m[2].trim() });
    else if (k) current.push({ mark: BOX_MARK[k[1]], text: k[2].trim() });
    else if (line.trim() !== '') close(); // a blank line may sit inside a list, other text ends it
  }
  close();
  return runs.length ? runs[runs.length - 1] : null;
}

export function lastChecklist(texts) {
  for (let i = texts.length - 1; i >= 0; i--) {
    const c = checklist(texts[i]);
    if (c) return c;
  }
  return null;
}

// -> null (turn may end) or { open: [...], reason: '...' }
export function verdict({ texts, stopHookActive }) {
  if (stopHookActive) return null;
  const list = lastChecklist(texts);
  if (!list) return null;
  const open = list.filter((p) => OPEN.has(p.mark));
  if (open.length === 0) return null;
  const listed = open.slice(0, 8).map((p) => `${p.mark} ${p.text.slice(0, 90)}`).join(' | ');
  return {
    open,
    reason: `COMPLETION LOOP: ${open.length} open item(s) in your last checklist: ${listed}. `
      + 'The end of a turn is not the end of the task. If executable work remains, continue. '
      + 'Otherwise mark each item ❌ (reason, or the blocker that needs the user) or ⏸ (waiting for '
      + 'a named background run or for the user) and show the updated checklist.',
  };
}

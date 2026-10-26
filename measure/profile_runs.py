# -*- coding: utf-8 -*-
"""Profile Claude Code subagent runs from their transcripts: where did the time go?

Reads every subagent transcript under ~/.claude/projects/*/<session>/subagents/**/agent-*.jsonl
(direct subagents and workflow agents; field "population") and prints one JSON line per run.
Claude Code removes main-session transcripts after about 30 days, subagent transcripts stayed
longer on my machine, so a long-term measurement has to rely on them.

Per run:
  wall_s       first to last timestamp
  idle_s       gaps of 600 s or more that do not fall inside an open tool call; a tool call
               without a result counts as open until the end of the transcript
  tool_s       union of the intervals tool_use -> tool_result (no double counting)
  model_s      gap from the last record of type "user" (prompt or tool result) to the first record
               of a new assistant message, below 600 s; technical attachments are NOT an anchor
               (they produced thousands of zero gaps in my data)
  turns        distinct message ids of assistant records; Claude Code writes every tool call on its
               own line, so a turn with three tool calls is three lines with one message id
  killed       Bash/PowerShell result with is_error and "Command timed out after"
  auto_background  Bash/PowerShell result "did not complete within ... moved to the background"
  wait_loops   durations of foreground Bash/PowerShell commands that the waitloop rule of guard.mjs
               would flag as a loop (whole command, also multi-line); a single long sleep is not
               counted here, nor a loop in a Monitor command
  over_limit_timeouts  Bash/PowerShell calls with a timeout above 600000 ms
Coverage per run: unpaired tool calls, lines that could not be parsed.

Usage:  python measure/profile_runs.py [--root DIR] [--exclude SESSION_ID] > runs.jsonl
Only the standard library is used.
"""
import argparse
import datetime
import glob
import json
import os
import re
import sys
from multiprocessing import Pool

# Same loop patterns as the waitloop rule in lib/rules.mjs, applied to the command with all whitespace
# collapsed, so multi-line loops count as well.
SLEEP_BASH = r"(?:^|[;&|(\s])sleep\s+[\d.]"
LOOP_BASH = re.compile(r"\b(?:while|until|for)\b.{0,200}?\bdo\b.{0,400}?" + SLEEP_BASH, re.I)
LOOP_PS = re.compile(r"\b(?:while|until|for|foreach|do)\b.{0,300}?Start-Sleep\b", re.I)


def is_wait_loop(command):
    c = re.sub(r"\s+", " ", command).strip()
    return bool(LOOP_BASH.search(c) or LOOP_PS.search(c))
BLOB_END = re.compile(r'"type"\s*:\s*"api-request-blob"\s*\}\s*$')
IDLE = 600.0
TIMEOUT_MAX_MS = 600000
SHELLS = ("Bash", "PowerShell")


def ts(s):
    return datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def union(intervals):
    intervals = sorted(intervals)
    total, a, b = 0.0, None, None
    for x, y in intervals:
        if a is None:
            a, b = x, y
        elif x <= b:
            b = max(b, y)
        else:
            total += b - a
            a, b = x, y
    if a is not None:
        total += b - a
    return total, intervals


def profile(path):
    records = []
    parse_errors = 0
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if BLOB_END.search(line[-80:]):
                    continue  # raw API request blob: no timestamp, large; its type key is at the end
                try:
                    d = json.loads(line)
                except Exception:
                    if line.strip():
                        parse_errors += 1
                    continue
                if not isinstance(d, dict) or d.get("type") == "api-request-blob" or not d.get("timestamp"):
                    continue
                try:
                    d["_t"] = ts(d["timestamp"])
                except Exception:
                    parse_errors += 1
                    continue
                records.append(d)
    except Exception as e:
        return {"file": path, "error": str(e)}
    if len(records) < 4:
        return None
    records.sort(key=lambda d: d["_t"])
    t0, t1 = records[0]["_t"], records[-1]["_t"]

    brief = ""
    for d in records:
        if d.get("type") == "user":
            c = (d.get("message") or {}).get("content")
            if isinstance(c, str):
                brief = c
            elif isinstance(c, list):
                brief = "".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text")
            break

    open_calls, intervals, wait_loops, model_gaps = {}, [], [], []
    turns, tool_turns, seen, tools, models = set(), set(), set(), {}, {}
    calls = background = monitor = over_limit = killed = auto_bg = 0
    anchor = None
    for d in records:
        t = d["_t"]
        kind = d.get("type")
        msg = d.get("message") or {}
        parts = msg.get("content") if isinstance(msg.get("content"), list) else []
        if kind == "assistant":
            mid = msg.get("id") or d.get("uuid")
            if mid not in seen:
                seen.add(mid)
                if anchor is not None and 0 <= t - anchor < IDLE:
                    model_gaps.append(t - anchor)
                anchor = None  # one gap per anchor
                if msg.get("model"):
                    models[msg["model"]] = models.get(msg["model"], 0) + 1
            turns.add(mid)
            for p in parts:
                if not isinstance(p, dict) or p.get("type") != "tool_use":
                    continue
                tool_turns.add(mid)
                calls += 1
                name = p.get("name") or "?"
                tools[name] = tools.get(name, 0) + 1
                inp = p.get("input") if isinstance(p.get("input"), dict) else {}
                command = str(inp.get("command") or "")
                bg = bool(inp.get("run_in_background"))
                background += bg
                monitor += name == "Monitor"
                # Both rules of guard.mjs apply to shell calls only: a Monitor command is a watcher,
                # not a foreground wait, and other tools may carry their own timeout field.
                shell = name in SHELLS
                limit = inp.get("timeout")
                if shell and isinstance(limit, (int, float)) and limit > TIMEOUT_MAX_MS:
                    over_limit += 1
                is_loop = shell and bool(command) and not bg and is_wait_loop(command)
                open_calls[p.get("id")] = (t, is_loop, name)
        elif kind == "user":
            anchor = t
            for p in parts:
                if not isinstance(p, dict) or p.get("type") != "tool_result":
                    continue
                call = open_calls.pop(p.get("tool_use_id"), None)
                if not call:
                    continue
                if t >= call[0]:
                    intervals.append((call[0], t))
                    if call[1]:
                        wait_loops.append(t - call[0])
                if call[2] in SHELLS:
                    # Claude Code puts these messages at the start of the result (in my transcripts: 37 of 37
                    # kills, 344 of 348 background moves). The other 4 were the same words quoted inside a
                    # command's own output, so the whole text would count them falsely.
                    text = json.dumps(p.get("content"), ensure_ascii=False)[:400]
                    if p.get("is_error") and "Command timed out after" in text:
                        killed += 1
                    elif "did not complete within" in text and "moved to the background" in text:
                        auto_bg += 1

    tool_s, _ = union(intervals)
    still_open = [(start, t1) for start, _, _ in open_calls.values()]
    _, covered = union(intervals + still_open)
    times = [d["_t"] for d in records]
    idle = 0.0
    for i in range(1, len(times)):
        a, b = times[i - 1], times[i]
        if b - a >= IDLE and not any(x <= a and y >= b for x, y in covered):
            idle += b - a

    norm = path.replace("\\", "/")
    segs = norm.split("/")
    sub = segs.index("subagents") if "subagents" in segs else len(segs) - 1
    return {
        "agent": os.path.basename(path)[6:23], "session": segs[sub - 1][:8],
        "population": "workflow" if "/subagents/workflows/" in norm else "direct",
        "start": t0, "wall_s": t1 - t0, "idle_s": idle, "tool_s": tool_s,
        "model_s": sum(model_gaps), "model_gaps": model_gaps,
        "turns": len(turns), "tool_turns": len(tool_turns), "tool_calls": calls,
        "background": background, "monitor": monitor, "over_limit_timeouts": over_limit,
        "killed": killed, "auto_background": auto_bg, "wait_loops": wait_loops,
        "brief_chars": len(brief), "tools": tools, "models": models,
        "unpaired": len(open_calls), "parse_errors": parse_errors,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=os.path.join(os.path.expanduser("~"), ".claude", "projects"))
    ap.add_argument("--exclude", action="append", default=[], help="session id to skip, e.g. the running one")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    files = glob.glob(os.path.join(args.root, "*", "*", "subagents", "**", "agent-*.jsonl"), recursive=True)
    files = [f for f in files if not any(x in f for x in args.exclude)]
    files.sort(key=lambda f: -os.path.getsize(f))
    sys.stderr.write("transcripts: %d\n" % len(files))
    with Pool(args.workers) as pool:
        for r in pool.imap_unordered(profile, files, chunksize=2):
            if r:
                print(json.dumps(r), flush=True)


if __name__ == "__main__":
    main()

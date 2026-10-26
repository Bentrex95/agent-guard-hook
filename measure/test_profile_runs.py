# -*- coding: utf-8 -*-
"""Golden test for profile_runs.profile(): a synthetic transcript with known values.

Usage: python measure/test_profile_runs.py [module]   (module defaults to profile_runs)
Exit 0 = every expected value hit, 1 = a deviation. selfcheck_profile.py runs this test against
deliberately broken copies; it must fail every time.
"""
import datetime
import importlib
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
mod = importlib.import_module(sys.argv[1] if len(sys.argv) > 1 else "profile_runs")
T0 = datetime.datetime(2026, 10, 1, 10, 0, 0, tzinfo=datetime.timezone.utc)


def ts(s):
    return (T0 + datetime.timedelta(seconds=s)).isoformat().replace("+00:00", "Z")


def assistant(s, mid, tools):
    return {"type": "assistant", "timestamp": ts(s), "message": {"id": mid, "model": "m", "content": tools}}


def result(s, tid, text="ok", error=False):
    return {"type": "user", "timestamp": ts(s),
            "message": {"content": [{"type": "tool_result", "tool_use_id": tid, "content": text, "is_error": error}]}}


def call(tid, command, name="Bash", **extra):
    inp = {"command": command}
    inp.update(extra)
    return {"type": "tool_use", "id": tid, "name": name, "input": inp}


RECORDS = [
    {"type": "user", "timestamp": ts(0), "message": {"content": "x" * 4000}},
    # Claude Code writes every tool call of a turn on its own line with the same message id.
    assistant(5, "m1", [call("a", "ls")]),                                # model gap 5 s
    assistant(5, "m1", [call("b", "pwd")]),                               # same turn: two tools, one turn
    result(15, "a"), result(25, "b"),                                     # tool time 5..25 = 20 s (union)
    assistant(35, "m2", [call("c", "until grep -q EXIT x.log\ndo\n  sleep 5\ndone", timeout=900000)]),  # gap 10 s, MULTI-LINE wait loop, over limit
    result(735, "c", "Exit code 143\nCommand timed out after 10m 0s", True),  # 700 s inside an open call -> not idle; killed
    {"type": "attachment", "timestamp": ts(740)},                         # attachment is NOT an anchor for the model gap
    assistant(745, "m3", [call("d", "npm test", run_in_background=True)]),  # gap 10 s, background
    result(746, "d"),
    assistant(1500, "m4", [call("e", "cat x")]),                          # gap 754 s >= 600 -> idle, no model gap
    {"type": "attachment", "timestamp": ts(2300)},                        # 800 s inside the unpaired call e -> not idle
    assistant(2310, "m5", [call("f", "npm run build")]),                  # no anchor since m4 -> no model gap
    result(2320, "f", "Command did not complete within its 120s timeout and was moved to the background (ID: b1)."),  # auto background
    assistant(2330, "m6", [call("g", "cat report.txt")]),                 # gap 10 s
    result(2340, "g", "x" * 500 + " Command did not complete within its 180s timeout and was moved to the background (ID: b2)."),  # QUOTED in output -> not counted
    # Not shell calls: a loop in a Monitor command is a watcher, a Read timeout is not the shell limit.
    assistant(2350, "m7", [call("h", "until grep -q EXIT x.log; do sleep 5; done", name="Monitor")]),  # gap 10 s
    assistant(2350, "m7", [call("i", "", name="Read", timeout=9999999)]),
    result(2355, "h"), result(2355, "i"),                                 # tool time +5 s
    {"type": "api-request-blob", "hash": "h", "message": {"x": 1}},
]
EXPECTED = dict(wall_s=2355, idle_s=754, tool_s=20 + 700 + 1 + 10 + 10 + 5, turns=7, tool_turns=7, tool_calls=9, background=1,
                over_limit_timeouts=1, killed=1, auto_background=1, unpaired=1, wait_loops=[700.0], brief_chars=4000,
                model_s=45, monitor=1)

fd, path = tempfile.mkstemp(suffix=".jsonl")
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    for d in RECORDS:
        fh.write(json.dumps(d) + "\n")
got = mod.profile(path)
os.remove(path)
wrong = []
for key, want in EXPECTED.items():
    have = got.get(key)
    if isinstance(want, (int, float)) and not isinstance(want, bool):
        ok = isinstance(have, (int, float)) and abs(have - want) < 0.01
    else:
        ok = have == want
    if not ok:
        wrong.append("%s: expected %r, got %r" % (key, want, have))
print("\n".join(wrong) if wrong else "PASSED: all %d expected values hit" % len(EXPECTED))
# The last line names how many values were compared, so a run that stopped early never looks complete.
print("CHECKED: %d of %d values, %d wrong" % (len(EXPECTED), len(EXPECTED), len(wrong)))
sys.exit(1 if wrong else 0)

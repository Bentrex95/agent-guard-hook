# -*- coding: utf-8 -*-
"""Checks the golden test itself: each break below goes into a copy of profile_runs.py, and the
golden test must fail against every copy. A test that has never been seen failing proves nothing.

Usage: python measure/selfcheck_profile.py
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "profile_runs.py"), encoding="utf-8").read()

# [name, text that must occur exactly once, replacement]
BREAKS = [
    ["idle also counted inside open tool calls", "if b - a >= IDLE and not any(x <= a and y >= b for x, y in covered):", "if b - a >= IDLE:"],
    ["wait-loop pattern blind", "return bool(LOOP_BASH.search(c) or LOOP_PS.search(c))", "return False"],
    ["whitespace no longer collapsed, multi-line loops invisible", 'c = re.sub(r"\\s+", " ", command).strip()', "c = command.strip()"],
    ["timeout limit raised", "TIMEOUT_MAX_MS = 600000", "TIMEOUT_MAX_MS = 6000000"],
    ["attachments become an anchor for the model gap again", 'elif kind == "user":', 'elif kind in ("user", "attachment"):'],
    ["unpaired calls no longer kept open", "still_open = [(start, t1) for start, _, _ in open_calls.values()]", "still_open = []"],
    ["killed commands not recognized", '"Command timed out after" in text', '"zzz" in text'],
    ["tools counted per line instead of per message", "tool_turns.add(mid)", "tool_turns.add(id(d))"],
    ["background message also counted when quoted deep in the output", "text = json.dumps(p.get(\"content\"), ensure_ascii=False)[:400]", "text = json.dumps(p.get(\"content\"), ensure_ascii=False)"],
    ["background moves not recognized", 'elif "did not complete within" in text', 'elif "zzz" in text'],
    ["loops in non-shell commands (Monitor) counted", "is_loop = shell and bool(command)", "is_loop = bool(command)"],
    ["timeouts of non-shell tools counted", "if shell and isinstance(limit, (int, float))", "if isinstance(limit, (int, float))"],
]

bad = 0
clean = subprocess.run([sys.executable, os.path.join(HERE, "test_profile_runs.py")], capture_output=True, text=True)
# The number of values the untouched run compares; a broken run must compare exactly as many.
base = re.match(r"^CHECKED: (\d+) of \1 values, 0 wrong$", (clean.stdout.strip().splitlines() or [""])[-1])
if clean.returncode != 0 or not base:
    print("FAIL  the untouched profiler does not pass its golden test")
    bad += 1
else:
    print("ok    untouched profiler passes (%s values)" % base.group(1))
for name, find, replace in BREAKS:
    hits = SRC.count(find)
    if hits != 1:
        print("FAIL  %s: marker found %d times, expected exactly 1 (dead probe)" % (name, hits))
        bad += 1
        continue
    tmp = tempfile.mkdtemp(prefix="profile-selfcheck-")
    try:
        with open(os.path.join(tmp, "broken_profile.py"), "w", encoding="utf-8") as fh:
            fh.write(SRC.replace(find, replace))
        shutil.copy(os.path.join(HERE, "test_profile_runs.py"), tmp)
        r = subprocess.run([sys.executable, os.path.join(tmp, "test_profile_runs.py"), "broken_profile"],
                           capture_output=True, text=True, cwd=tmp)
        lines = r.stdout.strip().splitlines() or ["(no output)"]
        first = lines[0]
        # Detected only if the golden test compared ALL values and at least one was wrong. An early exit
        # with code 1 and no comparison must not count as a detected break.
        complete = re.match(r"^CHECKED: (\d+) of \1 values, ([1-9]\d*) wrong$", lines[-1])
        if r.returncode == 1 and complete and base and complete.group(1) == base.group(1) and "Traceback" not in r.stderr:
            print("ok    %s: golden test turns red (%s)" % (name, first))
        else:
            print("FAIL  %s: golden test did not fail cleanly (exit %s, %s)" % (name, r.returncode, first))
            bad += 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
print("\nPASSED: the golden test catches all %d deliberate breaks" % len(BREAKS) if bad == 0 else "\nFAILED: %d problem(s)" % bad)
sys.exit(1 if bad else 0)

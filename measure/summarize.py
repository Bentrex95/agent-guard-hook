# -*- coding: utf-8 -*-
"""Summarize the output of profile_runs.py per period, or per week.

Periods are calendar cohorts by the start of a run, split at the times given with --split (UTC).
They show what coincided with a change, not what caused it: models, Claude Code versions and the
mix of tasks change at the same time as your rules.

Usage:
  python measure/summarize.py runs.jsonl --split 2026-08-07T12:31 --split 2026-10-01
  python measure/summarize.py runs.jsonl --weekly
Options: --population direct|workflow|all (default direct), --until ISO time, --json
"""
import argparse
import datetime
import json
import statistics
import sys


def utc(s):
    # Python 3.10 does not accept a trailing "Z" in fromisoformat.
    d = datetime.datetime.fromisoformat(s[:-1] + "+00:00" if s.endswith("Z") else s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=datetime.timezone.utc)
    return d.timestamp()


def work(r):
    return r["wall_s"] - r["idle_s"]


def figures(runs):
    if not runs:
        return {"runs": 0}
    calls = sum(r["tool_calls"] for r in runs)
    tool_turns = sum(r["tool_turns"] for r in runs)
    tool_s = sum(r["tool_s"] for r in runs)
    model_s = sum(r["model_s"] for r in runs)
    gaps = [g for r in runs for g in r["model_gaps"]]
    per100 = lambda n: round(100 * n / calls, 2) if calls else None
    longest = sorted(runs, key=work, reverse=True)[:8]
    lw = sum(work(r) for r in longest)
    lt = sum(r["tool_s"] for r in longest)
    lm = sum(r["model_s"] for r in longest)
    return {
        "runs": len(runs),
        "work_h": round(sum(work(r) for r in runs) / 3600, 1),
        "tools_per_turn": round(calls / tool_turns, 2) if tool_turns else None,
        "model_gap_median_s": round(statistics.median(gaps), 1) if gaps else None,
        "over_limit_timeouts_per_100": per100(sum(r["over_limit_timeouts"] for r in runs)),
        "killed": sum(r["killed"] for r in runs),
        "wait_loops_per_100": per100(sum(len(r["wait_loops"]) for r in runs)),
        "background_per_100": per100(sum(r["background"] for r in runs)),
        "seconds_per_tool_round": round((tool_s + model_s) / tool_turns, 1) if tool_turns else None,
        "longest8_by_work": {
            "wall_h": round(sum(r["wall_s"] for r in longest) / 3600, 1),
            "idle_h": round(sum(r["idle_s"] for r in longest) / 3600, 1),
            "tool_h": round(lt / 3600, 1), "model_h": round(lm / 3600, 1),
            "other_h": round((lw - lt - lm) / 3600, 1),
            "tool_share_of_work": round(100 * lt / lw) if lw else None,
            "model_share_of_work": round(100 * lm / lw) if lw else None,
        },
        "unpaired_tool_calls": sum(r["unpaired"] for r in runs),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("runs")
    ap.add_argument("--split", action="append", default=[])
    ap.add_argument("--until")
    ap.add_argument("--weekly", action="store_true")
    ap.add_argument("--population", default="direct", choices=["direct", "workflow", "all"])
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    runs = [json.loads(z) for z in open(args.runs, encoding="utf-8") if z.strip()]
    runs = [r for r in runs if "error" not in r and (args.population == "all" or r["population"] == args.population)]
    if args.until:
        runs = [r for r in runs if r["start"] < utc(args.until)]

    groups = {}
    if args.weekly:
        for r in runs:
            d = datetime.datetime.fromtimestamp(r["start"], datetime.timezone.utc).date()
            groups.setdefault(str(d - datetime.timedelta(days=d.weekday())), []).append(r)
        groups = dict(sorted(groups.items()))
    else:
        # Sort boundaries and their labels together, so labels follow time even with mixed offsets.
        ordered = sorted((utc(s), s) for s in args.split)
        cuts = [float("-inf")] + [t for t, _ in ordered] + [float("inf")]
        labels = ["start"] + [s for _, s in ordered] + ["end"]
        for i in range(len(cuts) - 1):
            groups["%s .. %s" % (labels[i], labels[i + 1])] = [r for r in runs if cuts[i] <= r["start"] < cuts[i + 1]]

    result = {k: figures(v) for k, v in groups.items()}
    if args.json:
        json.dump(result, sys.stdout, indent=1)
        print()
        return
    for k, f in result.items():
        print("== %s" % k)
        for key, val in f.items():
            print("   %-30s %s" % (key, val))


if __name__ == "__main__":
    main()

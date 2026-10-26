# agent-guard-hook

Three hooks for Claude Code and one report script that enforce working rules for coding agents, a profiler that measures from the transcripts what changed after the rules came in, plus tests that are themselves tested.

I run several coding agents every day. Some rules sat in my agent instructions and were still broken again and again, for example "never wait in a foreground loop", "do not stop while work is still open" or "do not call it done without proof". A rule that a program can check belongs in a hook, not only in a prompt. These pieces check it on every tool call, at the end of every turn, and in a report the agent quotes before it calls a task done.

This is an extract from the setup I use daily. Comments are translated from German, and the rules that only make sense on my machine or in my projects are left out.

## The pieces

### `guard.mjs`: stop a bad tool call before it runs

| Rule | What it catches | Mode |
|---|---|---|
| `timeout` | A shell command with a timeout above 600,000 ms. The runner silently caps it and kills the command at 600 s. | block |
| `secondmodel` | A second model (Codex) started without a sandbox. A reviewer with write access is no longer independent of the builder. | block |
| `waitloop` | A foreground loop with `sleep`, in Bash or PowerShell, also across several lines, or a single foreground sleep of 60 s or more. | hint |
| `bom` | A file written with a UTF-8 BOM where it silently breaks things (`.bat`, `.json`, `.mjs` and others). | flagged after the write (exit 2; the file is already written) |

Every rule is evaluated and a blocking rule wins, so a logged rule cannot hide a blocking one in the same command.

A `hint` lets the call run and gives the model the reason as `additionalContext`, next to the tool result. It carries no `permissionDecision`: `allow` would skip the user's permission prompt, `deny` would turn a hint into a block and `ask` into a question to the user.

The wait-loop rule used to log silently (`audit`). Measuring my own runs eleven weeks later found detected wait loops back at about seven tenths of their rate before the rule existed. Two things in my setup point that way: the hook only logged and never told the agent, and my own instructions asked subagents to collect background results in the same turn. In October, 94 percent of the detected loops polled a log or output file. That these are the causes is my reading, not a measurement.

### `stop.mjs`: no end of turn while checklist items are open

Agents like to stop with a status report while work is still open. This hook reads the last checklist of the current round. If an item is still open (⬜) or running (🔄), the end of the turn is rejected once and the open items come back as the next instruction. Allowed end states are done (✅), failed with a reason (❌) and waiting for something named (⏸).

### `budget.mjs`: show the agent the clock

This hook writes a line such as `Elapsed: 500s / 600s (83 %). 80 % used: core and verification only.` into the agent's context, at most once a minute and immediately when a threshold is crossed. A budget exists only when one was stated ("Budget: 30 min", "Budget: 2 hours", or a bare number for minutes). A number followed by a word that is not a time unit, such as "Budget: 500 dollars", is not a time budget.

### `verify-report.mjs`: a status block the agent quotes

An agent that writes "all tests pass" is summarizing, and summaries drift towards good news. This script runs the verification steps of a project one by one, hashes the state of the repository before and after, and prints one block with exactly one status:

| Status | Meaning |
|---|---|
| `VERIFIED` | Every step green, and nothing changed while the steps ran. |
| `PARTIAL` | Green, but only a subset ran, the working tree changed during the run, or a file could not be read while measuring the state. |
| `BLOCKED` | A step is red or the configuration is invalid. Steps after a red one are not started. |
| `STALE` | The stored report no longer matches the code (`--check`). |
| `INVALID` | The stored status does not follow from the steps and hashes stored with it (`--check`). |

The block also prints a maintained list of what the run does not prove. The agent quotes the block verbatim; a claim of "done" without it does not count.

`--check` does not trust the stored status. It derives the status again from the stored evidence and prints the block from that, so a report file that was edited by hand is rejected.

A step that hangs is ended at a time limit and counts as red. On Windows the whole process tree is ended with `taskkill`; elsewhere the step runs in its own process group and the group is killed. The report says whether the kill reported success, and the run does not wait forever if something keeps the output open.

```
=== VERIFY REPORT ===
Mode:      full run
State:     HEAD 3f2a9c1d07be (main), state hash 9b1c44e0a7d2, working tree without diff against HEAD, 0 untracked file(s) in scope
           after the run: state hash 9b1c44e0a7d2 -> unchanged
Passed (2/2):
  [OK]  unit                 4.2 s  exit 0
  [OK]  boot                11.8 s  exit 0
Not checked:
  - bundle content: the build step only checks that the build succeeds [evidence: verify.config.json]
Open:
  (nothing)
Status: VERIFIED
=== END ===
```

This repository verifies itself with it: see `verify.config.json`.

### `measure/`: what changed after the rules came in?

A rule in a hook is a claim about behavior. `measure/profile_runs.py` checks the claim against the transcripts Claude Code writes for every subagent: one JSON line per run with wall-clock time, idle time, tool time, the gaps until the model answers, tools per turn, timeouts above the limit, commands killed at the limit and foreground wait loops; like the guard, the last three count Bash and PowerShell calls only, while rates are per 100 tool calls of any kind. `measure/summarize.py` groups the runs by period or by week.

```bash
python measure/profile_runs.py --exclude <current-session-id> > runs.jsonl
python measure/summarize.py runs.jsonl --split 2026-08-07T12:31 --split 2026-10-01
```

Definitions that matter: idle time is a gap of 600 s or more that does not fall inside an open tool call. A turn is one assistant message id; in the transcripts I measured, Claude Code wrote each tool call on its own line, so a checker that counts lines sees one tool per turn even when the agent bundled three. The model gap starts at the last prompt or tool result, never at a technical attachment record.

What it showed on my own runs, 340 direct subagent runs before I wrote the rules (until August 7, 2026) and 708 in October 2026, eleven weeks later. Tools per turn are counted per message.

| | Until Aug 7 | October |
|---|---:|---:|
| Commands killed at the tool time limit, per 10,000 tool calls | 7.7 | 0 |
| Tools per tool-using turn | 1.18 | 1.63 |
| Gaps attributed to the model, share of working time, eight runs with the most work (approximation) | 28% | 14% |
| Detected wait-loop patterns per 100 tool calls | 1.16 | 0.82 |

No command was killed at the time limit any more. Detected wait loops fell to less than a quarter in the twelve days after the rule was written, before the hook took effect on August 20, and were back at about seven tenths of the earlier rate in October, which is why the rule gives hints now. Rules, model and Claude Code version changed at the same time, so the table cannot assign a change to a single cause. The full write-up: [Profiling coding-agent runs](https://dangelstudio.de/en/work/agent-runs/).

Only the standard library is used (Python 3.10 or newer). The profiler reads the transcripts and writes nothing.

## Design decisions

- **Fail open.** Any unexpected error in a hook lets the call through. A broken guard must never stop real work.
- **A mode per rule.** Rules that read a structured field block. Rules that depend on a text pattern do not block, because a pattern recognizes exactly the shapes its author thought of; the second-model rule is the exception, as a placeholder until real isolation exists. The wait-loop rule replaced a checker that was blind to multi-line loops, and its own test had the same blind spot. A rule that only logs gives the agent nothing to react to, so a pattern rule should at least tell the agent.
- **Measure the rule, not just the hook.** A green test proves the hook reacts to the cases in the test. Whether agents behave differently is a separate question, answered from the transcripts.
- **Pure logic, thin wrappers.** The decisions live in functions without file or process access. The program files only read the event and print the answer.
- **Say what was not checked.** A green status with a silent gap is worse than a yellow one.

## Run it

Needs Node 20 or newer and git, no dependencies. `measure/` and the full verify run also need Python 3.10 or newer (standard library only).

```bash
npm test
```

runs the acceptance test of the guard (19 legitimate calls that must go through, 15 violations that must be caught, the BOM check, the fail-open cases), 14 tests for the completion loop and the time budget, and 18 tests for the verify report, eight of which run the program in a temporary git repository.

```bash
npm run selfcheck
```

checks the tests themselves. It breaks one thing at a time in a copy of the code, 40 breaks in total, and expects the tests to fail every time. A break counts as detected only when the test file ran all its tests and at least one failed; a crash, a timeout or a file that could not start does not count. A test that has never been seen failing proves nothing.

```bash
python measure/test_profile_runs.py
python measure/selfcheck_profile.py
```

run the golden test of the profiler (a synthetic transcript with 15 known values) and break the profiler twelve times in a copy; the golden test must fail every time, and a break counts only if the test compared as many values as the untouched run.

```bash
node verify-report.mjs
```

runs all of the above through the report script and prints the block.

## Use it in Claude Code

Add the hooks to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|PowerShell", "hooks": [{ "type": "command", "command": "node /path/to/agent-guard-hook/guard.mjs" }] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "node /path/to/agent-guard-hook/guard.mjs" }] },
      { "hooks": [{ "type": "command", "command": "node /path/to/agent-guard-hook/budget.mjs" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /path/to/agent-guard-hook/budget.mjs" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node /path/to/agent-guard-hook/stop.mjs" }] }
    ]
  }
}
```

For the report, put a `verify.config.json` into the project, add `.verify-report.json` to `.gitignore`, and tell the agent in its instructions to quote the block.

Set `GUARD_AUDIT_LOG` to a file path to record what the hint and audit rules see. Set `GUARD_OFF=1` to switch the three hooks off.

## Limits

- The wait-loop and second-model rules are patterns. Other shell syntax, nested quotes or encoded commands are untested.
- The second-model rule is a placeholder. A marker word in a command is not a permission boundary; real isolation needs a sandbox or a separate user.
- The completion loop rejects only once per turn and does not fire when the user interrupts. An agent that never writes a checklist is not affected.
- The verify report proves that the configured steps ran green on this state. It proves nothing about what the steps themselves fail to test; that is what the "not checked" list and the self-check are for.
- The time limit was only tested on Windows. The process-group kill for Linux and macOS is written but not run.
- `--check` catches a report whose status contradicts its own evidence. It cannot catch a report in which the evidence itself was rewritten consistently.
- The numbers in the messages (600 s cap) were measured in my own environment. That a finished background job wakes a subagent was tested twice with Claude Code 2.1.308; in August, with an earlier version, a subagent stayed asleep.
- The profiler compares calendar periods of one person's runs. It has no control group, and it reads a transcript format that Claude Code can change without notice.

## How it was built

I designed the rules and the tests and reviewed every change. Coding agents wrote most of the code, which is how I work. Before each release, a second model reviewed the code with fresh context. It found, among other things, an audit rule hiding a block rule, a stored report that was believed without its evidence, self-checks that counted a test file that could not start as a detected break, and in this version a profiler that missed multi-line wait loops and counted loops in commands that were not shell calls. The fixes and their tests are in.

## License

MIT, see [LICENSE](LICENSE).

# agent-guard-hook

Three hooks for Claude Code and one report script that enforce working rules for coding agents, plus tests that are themselves tested.

I run several coding agents every day. Some rules sat in my agent instructions for months and were still broken again and again, for example "never wait in a foreground loop", "do not stop while work is still open" or "do not call it done without proof". A rule that can be checked deterministically does not belong in a prompt. These pieces check it on every tool call, at the end of every turn and at the end of every task.

This is an extract from the setup I use daily. Comments are translated from German, and the rules that only make sense on my machine or in my projects are left out.

## The pieces

### `guard.mjs`: stop a bad tool call before it runs

| Rule | What it catches | Mode |
|---|---|---|
| `timeout` | A shell command with a timeout above 600,000 ms. The runner silently caps it and kills the command at 600 s. | block |
| `secondmodel` | A second model (Codex) started without a sandbox. A reviewer with write access is no longer independent of the builder. | block |
| `waitloop` | A foreground loop with `sleep`, in Bash or PowerShell, also across several lines. | audit |
| `bom` | A file written with a UTF-8 BOM where it silently breaks things (`.bat`, `.json`, `.mjs` and others). | block, after the write |

Every rule is evaluated and a blocking rule wins, so a logged rule cannot hide a blocking one in the same command.

### `stop.mjs`: the end of a turn is not the end of the task

Agents like to stop with a status report while work is still open. This hook reads the last checklist of the current round. If an item is still open (⬜) or running (🔄), the end of the turn is rejected once and the open items come back as the next instruction. Allowed end states are done (✅), failed with a reason (❌) and waiting for something named (⏸).

### `budget.mjs`: show the agent the clock

An agent has no sense of time. This hook writes a line such as `Elapsed: 500s / 600s (83 %). 80 % used: core and verification only.` into the agent's context, at most once a minute and immediately when a threshold is crossed. A budget exists only when one was stated ("Budget: 30 min"); the hook never invents one.

### `verify-report.mjs`: "done" is a quote, not a sentence

An agent that writes "all tests pass" is summarizing, and summaries drift towards good news. This script runs the verification steps of a project one by one, hashes the state of the repository before and after, and prints one block with exactly one status:

| Status | Meaning |
|---|---|
| `VERIFIED` | Every step green, and nothing changed while the steps ran. |
| `PARTIAL` | Green, but only a subset ran, or the working tree changed during the run. |
| `BLOCKED` | A step is red or the configuration is invalid. Steps after a red one are not started. |
| `STALE` | The stored report no longer matches the code (`--check`). |

The block also prints a maintained list of what the run does not prove. The agent quotes the block verbatim; a claim of "done" without it does not count. A step that hangs is ended at a time limit with its whole process tree and counts as red.

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

## Design decisions

- **Fail open.** Any unexpected error in a hook lets the call through. A broken guard must never stop real work.
- **A mode per rule.** Rules that read a structured field block. Rules that depend on a text pattern only log at first, because a pattern recognizes exactly the shapes its author thought of. The wait-loop rule replaced a checker that was blind to multi-line loops, and its own test had the same blind spot.
- **Pure logic, thin wrappers.** The decisions live in functions without file or process access. The program files only read the event and print the answer.
- **Say what was not checked.** A green status with a silent gap is worse than a yellow one.

## Run it

Needs Node 20 or newer and git, no dependencies.

```bash
npm test
```

runs the acceptance test of the guard (19 legitimate calls that must go through, 15 violations that must be caught, the BOM check, the fail-open cases), 14 tests for the completion loop and the time budget, and 14 tests for the verify report, six of which run the program in a temporary git repository.

```bash
npm run selfcheck
```

checks the tests themselves. It breaks one thing at a time in a copy of the code, 32 breaks in total, and expects the tests to fail every time. A crash or a timeout does not count as a detected break. A test that has never been seen failing proves nothing.

```bash
node verify-report.mjs
```

runs both of the above through the report script and prints the block.

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

Set `GUARD_AUDIT_LOG` to a file path to record what the audit rules see. Set `GUARD_OFF=1` to switch the three hooks off.

## Limits

- The wait-loop and second-model rules are patterns. Other shell syntax, nested quotes or encoded commands are untested.
- The second-model rule is a placeholder. A marker word in a command is not a permission boundary; real isolation needs a sandbox or a separate user.
- The completion loop rejects only once per turn and does not fire when the user interrupts. An agent that never writes a checklist is not affected.
- The verify report proves that the configured steps ran green on this state. It proves nothing about what the steps themselves fail to test; that is what the "not checked" list and the self-check are for.
- The numbers in the messages (600 s cap, 130 s versus 1 s) were measured in my own environment.

## How it was built

I designed the rules and the tests and reviewed every change. Coding agents wrote most of the code, which is how I work. Before publishing, a second model reviewed the code with fresh context and found an audit rule hiding a block rule; the fix and its test are in.

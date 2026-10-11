# agent-guard-hook

A small hook for Claude Code that enforces working rules for coding agents, plus a test that is itself tested.

I run several coding agents every day. Some rules sat in my agent instructions for months and were still broken again and again, for example "never wait in a foreground loop". A rule that can be checked deterministically does not belong in a prompt. This hook checks it on every tool call.

This is an extract from the setup I use daily. Comments are translated from German and the rules that only make sense on my machine are left out.

## What it does

The hook reads the JSON of a tool call and decides before the call runs.

| Rule | What it catches | Mode |
|---|---|---|
| `timeout` | A shell command with a timeout above 600,000 ms. The runner silently caps it and kills the command at 600 s. | block |
| `secondmodel` | A second model (Codex) started without a sandbox. A reviewer with write access is no longer independent of the builder. | block |
| `waitloop` | A foreground loop with `sleep`, in Bash or PowerShell, also across several lines. | audit |
| `bom` | A file written with a UTF-8 BOM where it silently breaks things (`.bat`, `.json`, `.mjs` and others). | block, after the write |

Two design decisions matter more than the rules themselves:

- **Fail open.** Any unexpected error in the hook lets the call through. A broken guard must never stop real work.
- **A mode per rule.** Rules that read a structured field block. Rules that depend on a text pattern only log at first, because a pattern recognizes exactly the shapes its author thought of. The wait-loop rule replaced a checker that was blind to multi-line loops, and its own test had the same blind spot.

## Run it

Needs Node 20 or newer, no dependencies.

```bash
npm test
```

runs the acceptance test: 19 legitimate calls that must go through, 13 violations that must be caught, the BOM check, and the fail-open cases.

```bash
npm run selfcheck
```

checks the test itself. It breaks each rule on purpose in a copy of the hook and expects the acceptance test to fail every time. A test that has never been seen failing proves nothing.

## Use it in Claude Code

Add the hook to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|PowerShell", "hooks": [{ "type": "command", "command": "node /path/to/agent-guard-hook/guard.mjs" }] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "node /path/to/agent-guard-hook/guard.mjs" }] }
    ]
  }
}
```

Set `GUARD_AUDIT_LOG` to a file path to record what the audit rules see. Set `GUARD_OFF=1` to switch the hook off.

## Limits

- The wait-loop and second-model rules are patterns. Other shell syntax, nested quotes or encoded commands are untested.
- The second-model rule is a placeholder. A marker word in a command is not a permission boundary; real isolation needs a sandbox or a separate user.
- The numbers in the messages (600 s cap, 130 s versus 1 s) were measured in my own environment.

## How it was built

I designed the rules and the test and reviewed every change. Coding agents wrote most of the code, which is how I work.

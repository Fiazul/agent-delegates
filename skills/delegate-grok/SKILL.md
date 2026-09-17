---
name: delegate-grok
description: Use when delegating a task to a Grok Build (xAI) worker via the grok CLI — user says "grok", "use grok", or asks whether Grok weeklies have reset. Grok is a paid weekly budget; HTTP 402 means exhausted. Check with `agent-delegates status --probe-grok` before launching.
---

# Delegate to Grok Build

Third-vendor twin of a Claude subagent. Same brief/acceptance/review rules.
The launcher prepends the standard worker preamble.

Critical work (`--critical`): only `best` allowed.

## Tier ladder

| Tier | Grok model | ~Claude | Use for |
|------|------------|---------|---------|
| `fast` | grok-4.5 | Sonnet | standard build / fix / test |
| `best` | grok-4.6 | Opus | hard tasks, reviews |

`--effort E` selects reasoning effort. Raw model slugs also accepted.

## Commands

If `agent-delegates` exits 127 (not installed globally), use
`node ~/.agent-delegates/pkg/bin/cli.js` instead (Windows:
`node %LOCALAPPDATA%\agent-delegates\pkg\bin\cli.js`). Never fall back to `npx` — it
re-downloads the package every run.

```sh
agent-delegates run grok best BRIEF.md --cd /path/to/repo --name my-task
agent-delegates resume grok SESSION_ID FOLLOWUP.md --cd /path/to/repo
agent-delegates interrupt grok
agent-delegates close grok
```

`--yolo` enables `--always-approve` (needed for briefs that run commands;
headless mode can't prompt). Brief filename `-` reads stdin.

## Permissions

Without `--yolo`, headless Grok denies permission requests. Use `--yolo`
for briefs involving shell commands. Scope briefs to intended operations.

## Where the user sees it

One terminal window per vendor/name, opened by the first job and **reused**
by every later run/resume. The window shows: `BRIEF grok model` header,
narrative, tool activity, final result. Closes on `close` or after 10 idle
minutes (`DELEGATE_IDLE_MIN`). Red only for worker failure.

No display → tmux fallback; `DELEGATE_NO_WINDOW=1` → plain inline run.

## Verify

- Check artifact state (git status, file mtimes), not the narrative.
- `OPEN QUESTIONS` non-empty → `resume`, don't respawn.
- Non-trivial diff → review as usual.

## Gotchas

| Symptom | Cause / fix |
|---------|-------------|
| `API error (status 402 ...) Grok Build usage balance exhausted` | Weekly budget exhausted. The launcher stamps `~/.grok/.last_402`. Reroute to Antigravity or Codex. |
| `agent-delegates status` shows `logged in · quota via --probe-grok` | Add `--probe-grok` to make a tiny paid call that refreshes the status. |
| JSON `session_id` field name uncertain | If resume fails, check `events.jsonl` for the actual field name (`session_id` / `sessionId`). The launcher tries all variants. |

Clean room: `~/.grok/AGENTS.md` and `~/.grok/config.toml` load by default.
`grok --agent <file>` and `--disallowed-tools` are the switches — untested
until balance is back.

---
name: delegate-opencode
description: Use when delegating a task to an OpenCode worker — user says "opencode", "use opencode", or wants an OpenCode free/go model. Runs non-interactively via `opencode run --format json`.
---

# Delegate to OpenCode

For any orchestrator that wants to delegate to OpenCode.
Same brief/acceptance/review rules as all other vendor workers.
The launcher prepends the standard worker preamble.

Critical work (`--critical`): none — opencode has no large tier and is refused outright unless `--allow-small`.

## Tier ladder

| Tier | OpenCode model | Use for |
|------|----------------|---------|
| `free` | opencode/mimo-v2.5-free | **default** free-tier work |
| `go` | opencode-go/kimi-k2.7-code | harder tasks on OpenCode Go |

`--yolo` maps to `--auto`. Raw `provider/model` slugs from `opencode models` also work.

## Commands

If `agent-delegates` exits 127 (not installed globally), use
`node ~/.agent-delegates/pkg/bin/cli.js` instead (Windows:
`node %LOCALAPPDATA%\agent-delegates\pkg\bin\cli.js`). Never fall back to `npx` — it
re-downloads the package every run.

```sh
agent-delegates run opencode free BRIEF.md --cd /path/to/repo --name my-task
agent-delegates resume opencode SESSION_ID FOLLOWUP.md --cd /path/to/repo
agent-delegates interrupt opencode
agent-delegates close opencode
```

Brief filename `-` reads stdin.

## Permissions

Without `--yolo`, headless OpenCode may deny permission requests.
`--yolo` enables `--auto` (auto-approve permissions that are not explicitly
denied). Scope briefs carefully when using `--yolo`.

## Where the user sees it

One terminal window per vendor/name, opened by the first job and **reused**
by every later run/resume. The window shows: `BRIEF opencode model` header,
text, tool activity, and the final result. Closes on `close` or after 10
idle minutes (`DELEGATE_IDLE_MIN`). Red only for worker failure.

No display → tmux fallback; `DELEGATE_NO_WINDOW=1` → plain inline run.

## Verify

- Read `last.md` first; grep `events.jsonl` only to debug.
- `OPEN QUESTIONS` non-empty → `resume` to preserve context.
- Verify from artifact state (git status, file mtimes), not the narrative.
- Non-trivial diff → review as usual.

## Orchestration

Each job records `brief.md`, `prompt.md`, `events.jsonl`, `last.md`,
`session_id`, `exit`, and `stderr.log`. The launcher prints `out=`, `exit=`,
`session_id=`, `usage=`, `open=`, and the final message.

Set `DELEGATE_OUT` to a scratch directory; `CODEX_WORKER_OUT` is a fallback.
Console logs: `~/.cache/delegates/<name>/console.log` (POSIX) or
`%LOCALAPPDATA%/delegates/<name>/console.log` (Windows).

---
name: delegate-cursor
description: Use when delegating a task to a Cursor Agent CLI worker — user says "cursor", "use cursor", "composer", or wants a Cursor-side second opinion. Runs non-interactively via `agent -p`; binary is `agent`, vendor id is `cursor`.
---

# Delegate to Cursor Agent

For any orchestrator that wants to delegate to Cursor's headless CLI.
Same brief/acceptance/review rules as all other vendor workers.
The launcher prepends the standard worker preamble.

## Tier ladder

| Tier | Cursor model | Use for |
|------|--------------|---------|
| `auto` | auto | **default** — Cursor picks |
| `composer` | composer-2.5 | Cursor's Composer model |

`--yolo` maps to `--force`. Raw model ids from `agent --list-models` also work.

## Commands

Use `agent-delegates` when globally installed. Otherwise use
`npx github:Fiazul/agent-delegates` in every command.

```sh
agent-delegates run cursor auto BRIEF.md --cd /path/to/repo --name my-task
agent-delegates resume cursor SESSION_ID FOLLOWUP.md --cd /path/to/repo
agent-delegates interrupt cursor
agent-delegates close cursor
```

Brief filename `-` reads stdin.

## Permissions

Default headless run uses `--trust` so the workspace is trusted without a
prompt. Without `--yolo`, shell/tool approvals follow Cursor defaults.
`--yolo` enables `--force` (allow commands unless explicitly denied).
Scope briefs carefully when using `--yolo`.

## Where the user sees it

One terminal window per vendor/name, opened by the first job and **reused**
by every later run/resume. The window shows: `BRIEF cursor model` header,
assistant text, tool names with short inputs, and the final result. Closes
on `close` or after 10 idle minutes (`DELEGATE_IDLE_MIN`). Red only for
worker failure.

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

---
name: delegate-claude
description: Use when a Codex, Antigravity, or Grok agent needs to delegate work to a Claude Code worker — user says "use claude", "claude worker", "delegate to claude", or wants Claude's strengths on a subtask. Supports haiku/sonnet/opus tiers. Default permission is acceptEdits; --yolo bypasses permissions.
---

# Delegate to Claude Code

For a Codex, Antigravity, or Grok orchestrator that wants to delegate to
Claude Code. Same brief/acceptance/review rules as all other vendor workers.
The launcher prepends the standard worker preamble.

Critical work (`--critical`): only `opus` allowed.

## Tier ladder

| Tier | Claude model | Use for |
|------|--------------|---------|
| `haiku` | claude-haiku-4-5-20251001 | small / trivial tasks |
| `sonnet` | claude-sonnet-5 | **default** implementation |
| `opus` | claude-opus-5 | hard tasks, multi-step reasoning |

`--effort E` selects reasoning effort. Raw model slugs also accepted.

## Commands

Use `agent-delegates` when globally installed. Otherwise use
`npx github:Fiazul/agent-delegates` in every command.

```sh
agent-delegates run claude sonnet BRIEF.md --cd /path/to/repo --name my-task
agent-delegates resume claude SESSION_ID FOLLOWUP.md --cd /path/to/repo
agent-delegates interrupt claude
agent-delegates close claude
```

Brief filename `-` reads stdin. `--add-dir D` adds directories.

## Permissions

Default is `--permission-mode acceptEdits`: edits auto-approved, shell
commands denied. `--yolo` enables `--dangerously-skip-permissions` for
briefs that run commands. Scope briefs carefully when using `--yolo`.

## Where the user sees it

One terminal window per vendor/name, opened by the first job and **reused**
by every later run/resume. The window shows: `BRIEF claude model` header,
assistant text, tool names with short inputs, tool-result snippets, and the
final result. Closes on `close` or after 10 idle minutes
(`DELEGATE_IDLE_MIN`). Red only for worker failure.

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

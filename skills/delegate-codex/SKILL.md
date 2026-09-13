---
name: delegate-codex
description: Delegate scoped implementation or review work to a codex CLI worker.
---

# Delegate to codex

## Tiers and permissions

luna → gpt-5.6-luna; terra → gpt-5.6-terra; sol → gpt-5.6-sol; astra → gpt-6-astra.

Default workspace-write sandbox; --ro selects read-only. --effort defaults to medium. --add-dir D adds writable directories. Clean room uses ~/.codex-fresh with auth linked (POSIX) or copied (Windows) and plugins, recommended plugins, image generation, goals and memories disabled. --full uses the configured Codex home; repeat it on resume. Never use the Codex sandbox-bypass flag.

## Commands

Use `agent-delegates` when globally installed. Otherwise replace it with
`npx github:Fiazul/agent-delegates` in every command.

```sh
agent-delegates run codex terra BRIEF.md --cd "/path/to/repo"
agent-delegates resume codex ID FOLLOWUP.md --cd "/path/to/repo"
agent-delegates interrupt codex
agent-delegates close codex
```

Use `--name N` on run/resume for a named window; pass N to interrupt/close.
Always repeat the working directory on resume. Returned ID: `thread_id`.
Brief or follow-up filename `-` reads stdin. Raw vendor model slugs are supported.

## Orchestration

Write constraints and acceptance criteria into a brief. The shared preamble makes
the worker sole executor, prohibits delegation and secrets, and requires a
structured report. Run long jobs through the calling agent's background execution
facility. Review artifacts and diffs; do not trust a DONE narrative alone.
Answer OPEN QUESTIONS through resume to preserve context.

Set `DELEGATE_OUT` to a scratch directory; `CODEX_WORKER_OUT` remains a fallback.
Each job records brief.md, prompt.md, events.jsonl, last.md, thread_id, exit, and
stderr.log. Read last.md first. The launcher prints out=, exit=, ID, usage=,
open=, and the final message.

## Console

One window per vendor/name shows the brief, model, narrative, tool activity,
and final report. Later run/resume calls reuse it. Logs are mirrored to
`~/.cache/delegates/<name>/console.log`, or
`%LOCALAPPDATA%/delegates/<name>/console.log` on Windows.
`DELEGATE_IDLE_MIN` defaults to 10; `DELEGATE_NO_WINDOW=1` runs inline.
Interrupt kills the process tree and cancels queued work, keeping the window.
Close closes after current work. Linux uses desktop terminals then tmux;
macOS uses Terminal.app; Windows uses Windows Terminal then cmd.

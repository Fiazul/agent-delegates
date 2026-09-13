---
name: delegate-claude
description: Delegate scoped implementation or review work to a claude CLI worker.
---

# Delegate to claude

## Tiers and permissions

haiku → claude-haiku-4-5-20251001; sonnet → claude-sonnet-5; opus → claude-opus-5.

For a Codex, agy, or Grok agent delegating to Claude Code. Use haiku for small tasks, sonnet for implementation, and opus for difficult work. Default permission mode is acceptEdits; --yolo enables --dangerously-skip-permissions. Supports --effort E and --add-dir D. Print mode uses verbose stream-json; the window displays assistant text, tool names and short inputs, tool-result snippets, and the final result.

## Commands

Use `agent-delegates` when globally installed. Otherwise replace it with
`npx github:Fiazul/agent-delegates` in every command.

```sh
agent-delegates run claude haiku BRIEF.md --cd "/path/to/repo"
agent-delegates resume claude ID FOLLOWUP.md --cd "/path/to/repo"
agent-delegates interrupt claude
agent-delegates close claude
```

Use `--name N` on run/resume for a named window; pass N to interrupt/close.
Always repeat the working directory on resume. Returned ID: `session_id`.
Brief or follow-up filename `-` reads stdin. Raw vendor model slugs are supported.

## Orchestration

Write constraints and acceptance criteria into a brief. The shared preamble makes
the worker sole executor, prohibits delegation and secrets, and requires a
structured report. Run long jobs through the calling agent's background execution
facility. Review artifacts and diffs; do not trust a DONE narrative alone.
Answer OPEN QUESTIONS through resume to preserve context.

Set `DELEGATE_OUT` to a scratch directory; `CODEX_WORKER_OUT` remains a fallback.
Each job records brief.md, prompt.md, events.jsonl, last.md, session_id, exit, and
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

---
name: delegate-antigravity
description: Delegate scoped implementation or review work to a agy CLI worker.
---

# Delegate to agy

## Tiers and permissions

lite → gemini-3.8-flash-low; flash → gemini-3.8-flash-high; pro → gemini-3.1-pro-high; sonnet → claude-sonnet-4-6; opus → claude-opus-4-6-thinking.

antigravity aliases agy. Default --dangerously-skip-permissions is needed for headless shell work; --safe selects accept-edits. Scope briefs carefully. --add-dir D adds a workspace directory. The launcher includes an absolute WORKING DIRECTORY header, allows that directory, disables slash commands, and sets a 60-minute print timeout. Check artifacts when lite claims success: tool_steps=0 is a warning sign.

## Commands

Use `agent-delegates` when globally installed. Otherwise replace it with
`npx github:Fiazul/agent-delegates` in every command.

```sh
agent-delegates run agy flash BRIEF.md --cd "/path/to/repo"
agent-delegates resume agy ID FOLLOWUP.md --cd "/path/to/repo"
agent-delegates interrupt agy
agent-delegates close agy
```

Use `--name N` on run/resume for a named window; pass N to interrupt/close.
Always repeat the working directory on resume. Returned ID: `conversation_id`.
Brief or follow-up filename `-` reads stdin. Raw vendor model slugs are supported.

## Orchestration

Write constraints and acceptance criteria into a brief. The shared preamble makes
the worker sole executor, prohibits delegation and secrets, and requires a
structured report. Run long jobs through the calling agent's background execution
facility. Review artifacts and diffs; do not trust a DONE narrative alone.
Answer OPEN QUESTIONS through resume to preserve context.

Set `DELEGATE_OUT` to a scratch directory; `CODEX_WORKER_OUT` remains a fallback.
Each job records brief.md, prompt.md, events.jsonl, last.md, conversation_id, exit, and
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

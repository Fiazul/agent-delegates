---
name: delegate-grok
description: Use when delegating a task to a Grok Build (xAI) worker via the `grok` CLI, or when the user says "grok", "use grok", or asks whether Grok weeklies have reset. Grok is a paid weekly budget; HTTP 402 means exhausted.
---

# Delegate to Grok Build

Third-vendor twin of `sonnet5-worker`; same brief/acceptance/review rules. Launcher:

```bash
export CODEX_WORKER_OUT=<scratchpad>/workers
~/.claude/skills/delegate-grok/grok-worker.sh run best BRIEF.md --name <task> --cd <repo> [--effort high] [--yolo]
echo "answer" | ~/.claude/skills/delegate-grok/grok-worker.sh resume <session_id> - --cd <repo>
```

Tiers: `fast` = grok-4.5 (~Sonnet), `best` = grok-4.6 (~Opus). `--yolo` = `--always-approve`
(needed for briefs that run commands; headless mode can't prompt). Run dir mirrors the codex
launcher (`last.md`, `session_id`, `exit`, `stderr.log`).

**Status 2026-09-13:** balance exhausted (`API error (status 402 ...) Grok Build usage balance
exhausted`). Check with `~/.claude/skills/delegates/delegates.sh --probe-grok` before
launching; on 402 reroute to Antigravity or Codex. The launcher itself is untested against a
live balance — first successful run should confirm the JSON `session_id` field name.

Clean room: `~/.grok/AGENTS.md` and `~/.grok/config.toml` load by default; `grok --agent <file>`
(custom agent definition with its own system prompt) and `--disallowed-tools` are the switches —
untested until the balance is back.

## Where the user sees it

One terminal window per vendor (titled `codex` / `agy` / `grok`, or `--name`), opened by the
first job and **reused** by every later run/resume; it closes on `close` or after 10 idle
minutes (`DELEGATE_IDLE_MIN`). The window is a file-driven job console: the orchestrator only
drops a job file, spends no tokens watching it, and gets exit code + `last.md` back.

```bash
<launcher> interrupt [name]   # kill the running job, drop queued ones, keep the window
<launcher> close [name]       # close the window (after the current job)
```

No display → tmux fallback; `DELEGATE_NO_WINDOW=1` → plain inline run.

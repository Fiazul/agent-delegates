# CLAUDE.md — agent-delegates

## What this project is

A zero-dependency Node CLI (`agent-delegates`) that runs Codex, Antigravity,
Grok Build, Claude Code, Cursor, and OpenCode workers in reusable terminal
windows. An orchestrating agent writes a brief, the launcher opens the worker
in a visible console, and collects `exit` + `last.md` when it finishes.

## Architecture

```
bin/cli.js          CLI entry point: parses commands, dispatches
  lib/runner.js     invoke() builds vendor-specific CLI args, submits job, parses result
  lib/console.js    job queue: one console per vendor/name, spawns terminal windows
  lib/renderer.js   EventRenderer: renders vendor-specific streaming events to the console
  lib/models.js     tier → model slug maps, canonicalVendor(), resolveModel()
  lib/status.js     quota probes: claude, codex, agy, grok rows
  lib/install.js    skill symlinks, statusline helper, shell aliases
  lib/util.js       homeDir, outputRoot, timestamp, readJson, shellQuote
  lib/process.js    cross-platform spawn wrapper
```

One reusable window per vendor/name. Console directories live at
`~/.cache/delegates/<name>` (POSIX) / `%LOCALAPPDATA%/delegates/<name>` (Windows).
Each job output: `<DELEGATE_OUT>/<name>-<ts>/` with `brief.md`, `prompt.md`,
`events.jsonl`, `last.md`, `exit`, `stderr.log`, and the vendor-specific ID file
(`thread_id` / `conversation_id` / `session_id`).

## Commands

```sh
npm test                                    # unit tests, must stay green
node bin/cli.js --help                      # show all commands and flags
node bin/cli.js status                      # quota table (no vendor calls needed for claude/codex)
node bin/cli.js run codex terra BRIEF.md --cd /path/to/repo
node bin/cli.js run agy flash BRIEF.md --cd /path/to/repo
DELEGATE_NO_WINDOW=1 node bin/cli.js run codex luna BRIEF.md --cd /path/to/repo  # inline, no window
```

## Decisions that must not be undone

- **One reusable window per vendor** — never open a new window per job.
- **Never tmux-attach UX** — never ask the user to attach to tmux.
- **Red only for worker failure** — not for info or warnings.
- **Brief + vendor·model header** in the console, always.
- **Clean room default for Codex** — `~/.codex-fresh` with auth only.
- **Zero runtime npm dependencies** — no lodash, no chalk, no nothing.
- **Commits use the personal identity** already set in `.git/config` — never change it.
- **Never push without the user's OK.**

## Gotchas

### Codex
- The Codex sandbox mounts `.git` read-only — a Codex worker cannot `git commit`.
  The orchestrator commits. Brief workers with "do not commit".
- When Codex hits the 5-hour usage limit mid-run, the stream ends with `turn.failed`
  and the launcher exits 1 with a message including the reset time. Resume the same
  thread after the reset.

### Antigravity
- Gemini flash burned ~75% of the weekly Gemini bucket in a dozen runs (250k input
  tokens per run is normal). The `claude/gpt` bucket is separate.
  `agent-delegates status` shows both. Budget accordingly.
- `--dangerously-skip-permissions` is the default because headless `accept-edits`
  auto-denies every shell command. `--safe` opts back in.

### Grok
- HTTP 402 means weekly budget exhausted. The launcher stamps `~/.grok/.last_402`.
  Reroute to Antigravity or Codex.

### General
- Always pass `--cd` on `resume` — otherwise the worker resumes in the wrong directory.
- Verify from artifact state (git status, file mtimes), not the worker's narrative.
- `DELEGATE_NO_WINDOW=1` runs inline when no display is available.

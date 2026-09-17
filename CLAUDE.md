# CLAUDE.md — agent-delegates

## What this project is

A zero-dependency Node CLI (`agent-delegates`) that runs Codex, Antigravity,
Grok Build, Claude Code, Cursor, and OpenCode workers in reusable terminal
windows. An orchestrating agent writes a brief, the launcher opens the worker
in a visible console, and collects `exit` + `last.md` when it finishes.

## Architecture

```
bin/cli.js          CLI entry point: parses commands, dispatches
  lib/runner.js     invoke() builds vendor-specific CLI args, submits job, parses result, runs the guard
  lib/console.js    job queue: one console per vendor/name, spawns terminal windows
  lib/renderer.js   EventRenderer: renders vendor-specific streaming events to the console
  lib/models.js     tier → model slug maps, CRITICAL_TIER, DEFAULT_TIER, canonicalVendor(), resolveModel()
  lib/status.js     quota probes: claude, codex, agy, grok, cursor, opencode rows; preflight() login check
  lib/failure.js    classifyFailure(): per-vendor quota/auth/timeout classification from a raw event stream
  lib/policy.js     pace-based routing decide()/routeCheck()/pick(): should the orchestrator go external?
  lib/guard.js      critical-work guard: assessCriticality(), enforce() (refuse small tiers), permissionMode()
  lib/route.js      run auto: pickVendor() from status rows, quota-exhaustion-only hop loop
  lib/handoff.js    builds a continuation brief from a finished job dir and fires it at another vendor
  lib/install.js    copies the package into installHome() first, then: skill symlinks, statusline +
                    routing-nudge hook install/uninstall, and the agent-delegates/delegates PATH shims
  lib/util.js       homeDir, installHome, outputRoot, timestamp, readJson, shellQuote
  lib/process.js    cross-platform spawn wrapper
extras/delegate-nudge.js  UserPromptSubmit + PreToolUse hook implementation (exports main() for the installed stub)
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
node bin/cli.js status                      # quota table, always probes vendors and refreshes the rows cache
node bin/cli.js run codex terra BRIEF.md --cd /path/to/repo
node bin/cli.js run agy flash BRIEF.md --cd /path/to/repo
DELEGATE_NO_WINDOW=1 node bin/cli.js run codex luna BRIEF.md --cd /path/to/repo  # inline, no window
node bin/cli.js route-check --json                       # routing decision; reads cached rows.json (<10min old) or probes and refreshes it; --probe forces a probe
node bin/cli.js pick --json                               # route-check + the actual vendor/tier/command to run
node bin/cli.js run auto BRIEF.md --cd /path/to/repo       # policy-aware, picks a vendor and hands off on exhaustion
node bin/cli.js handoff /path/to/out-dir codex terra --cd /path/to/repo   # continuation brief to another vendor
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
- Codex's process exit code is unreliable on `resume`: seen live 2026-09-17 — `turn.completed` + passing
  tests, yet the CLI exited 1 because of an unrelated background `codex_models_manager` refresh timeout on
  stderr. Judge success from `last.md`/`turn.completed` (the failure classifier does), not the raw code.
- `codex exec resume` has no `-m`/`--model` flag — pin the model via `-c model=<slug>`, otherwise
  Codex silently resumes on its own default (astra, the most expensive tier) instead of the model
  the thread was recorded with. Fixed 2026-09-18 (`lib/runner.js`'s `resolveResumeModel`, applied
  to every vendor's resume branch, not just codex's).

### Antigravity
- Gemini flash burned ~75% of the weekly Gemini bucket in a dozen runs (250k input
  tokens per run is normal). The `claude/gpt` bucket is separate.
  `agent-delegates status` shows both. Budget accordingly.
- `--dangerously-skip-permissions` is the default because headless `accept-edits`
  auto-denies every shell command. `--safe` opts back in.

### Grok
- HTTP 402 means weekly budget exhausted. The launcher stamps `~/.grok/.last_402`.
  Reroute to Antigravity or Codex.
- Researched 2026-09-17 (strings/grep over the `grok` Rust binary): there is no read-only
  account-balance/usage-quota HTTP endpoint. The TUI's `/usage` command reads *per-session token
  usage* via an internal ACP method (`x.ai/session/usage`), not account-level budget. `grok`
  status row therefore stays `logged in · quota via --probe-grok` until a real (billable) probe
  call is made — do not add a free-quota check for Grok without a new confirmed endpoint.

### Cursor
- `cursor-agent` has no CLI flag for quota, but its TUI's `/usage` screen backs onto a
  Connect-RPC service that also accepts plain JSON over HTTPS POST (no protobuf codec needed).
  Confirmed live 2026-09-17: `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`,
  body `{}`, header `Authorization: Bearer <accessToken>` (token from `~/.config/cursor/auth.json`,
  key `accessToken`). Response: `{ billingCycleEnd, planUsage: { totalPercentUsed, autoPercentUsed,
  apiPercentUsed, ... } }` — `totalPercentUsed` is the TUI's "Included X% used", `auto`/`api` are
  the same breakdown. `lib/status.js`'s `cursorRow` calls this (via an injectable fetcher for
  tests) and falls back to the old `logged in · no quota API` wording on any HTTP failure — it
  never throws.

### General
- Always pass `--cd` on `resume` — otherwise the worker resumes in the wrong directory.
- Verify from artifact state (git status, file mtimes), not the worker's narrative.
- `DELEGATE_NO_WINDOW=1` runs inline when no display is available.
- `DELEGATE_QUIET=1` is test-only: it silences the console mirror (including the brief + vendor·model
  header). Never export it globally.
- Every `run`/`resume` job has a 90-minute default timeout (`--timeout MIN` /
  `DELEGATE_JOB_TIMEOUT_MIN`); a killed job exits 124 and is classified "timed out" like any
  other failure — it does not trigger a `run auto` hop.
- The critical-work guard's keyword heuristic (brief text matched against `routing.json`'s
  `guard.keywords`/the built-in default list) only **warns** (`CRITICAL?`) — it never refuses a
  small/standard tier by itself. Only an explicit `--critical` flag or a `guard.paths` match
  against `--cd`/`--add-dir` actually refuses. `resume` never refuses either way — it only warns
  (via `enforce()`'s resume branch, which now prints the resolved model, not the id passed in
  place of a tier). The model can be pinned on a resumed thread with `resume --tier T` or
  `--model M` (`resolveResumeModel()` in lib/runner.js; `--tier` wins if both are given) instead
  of only ever inheriting whatever model the prior job in that thread recorded.
- `install`'s per-vendor login check (found/installed CLIs) reuses `lib/status.js`'s `preflight` —
  the same function `run` calls before every job — so "ok"/"logged-out"/"unknown" wording always
  agrees between `install` and `run`. agy has no local login marker or auth subcommand, so its
  check is the read-only `agy --output-format json -p /usage` call (same as the quota row):
  usage groups → ok, auth-error text → logged-out, anything else → unknown.
- `agent-delegates install` edits `~/.claude/settings.json` (statusLine + two hooks, on by
  default) — it always backs up the existing file to `settings.json.bak-<timestamp>` first, and
  merges rather than replaces (existing hooks/keys survive). A malformed existing
  `settings.json` makes `install` fail loudly before touching anything, rather than guessing.
- H3: nothing `install` leaves behind may reference the location it happened to run from — under
  `npx` that's a prunable cache dir. `install()`'s first step (`copyPackageToInstallHome` in
  `lib/install.js`) copies the running package (per `package.json`'s `files` list, plus
  `package.json` itself) into `installHome()`'s `pkg/` subdir (`lib/util.js`:
  `~/.agent-delegates` POSIX, `%LOCALAPPDATA%\agent-delegates` win32, falling back to
  `%USERPROFILE%\.agent-delegates`), fresh-replacing any prior copy; a no-op when already run
  from inside that home. Every artifact written after that (`installStatusline`, `installHook`/
  `installNudgeCopy`, the skill symlinks, the command shims) takes a `pkgRoot` parameter sourced
  from this copy, never `packageRoot()` directly. The command itself is a real shim (POSIX:
  `~/.local/bin/agent-delegates`/`delegates`; win32: `agent-delegates.cmd`/`delegates.cmd` in
  `installHome()/bin`), not a `.bashrc` alias — aliases don't exist in the non-interactive shells
  most agent tooling spawns. Every shim carries the `agent-delegates shim` marker comment so
  `install`/`--uninstall` can tell "ours" from a foreign file at the same path and never touch
  the latter. `--uninstall` removes the shims (if ours) and the whole `installHome()/pkg` copy;
  it never touches `routing.json`.
- `route-check`/`pick`/`run auto` read a vendor-status cache at `~/.cache/delegates/rows.json`
  (`%LOCALAPPDATA%/delegates/rows.json` on Windows) when younger than `rowsTtlMinutes` in
  `routing.json` (default 10 min), otherwise they probe and refresh it; `--probe` forces a fresh
  probe. `status` always probes and refreshes the cache regardless of age. None of these are
  "no vendor calls" operations — they just avoid redundant probes within the TTL window.
- Cursor's command is `cursor-agent` everywhere (never the bare `agent` name, which collides
  with Grok's own `agent` alias — see README.md "Cursor and Grok both install `agent`"); the
  installer's Cursor-presence check and the login preflight hint (`cursor-agent login`) both go
  through the same resolver as job invocation.
- The `agent` collision is a conflict for `install` to warn/prompt about only when something
  (Grok, or an unrecognized binary) shadows Cursor's `agent` in PATH order — `lib/bins.js`'s
  `assessAgentConflict`/`lib/install.js`'s `deriveAgentConflict` key on `hits[0].owner`, not on
  whether two owners merely exist somewhere on PATH; Cursor's `agent` winning PATH resolution
  (or Cursor not being installed) is never a conflict, at most a single `NOTE:` line.

# CLAUDE.md — agent-delegates

## What this project is

A zero-dependency Node CLI (`agent-delegates`) that runs Codex, Antigravity,
Grok Build, Claude Code, Cursor, and OpenCode workers in reusable terminal
windows. A main agent (Claude Code, Codex, or Cursor) writes a brief, the launcher opens the worker
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
node bin/cli.js status                      # quota table (claude + routing.json priority vendors; --all = every vendor), always probes and refreshes the rows cache
node bin/cli.js run codex sol BRIEF.md --cd /path/to/repo
node bin/cli.js run agy flash BRIEF.md --cd /path/to/repo
DELEGATE_NO_WINDOW=1 node bin/cli.js run codex sol-low BRIEF.md --cd /path/to/repo  # inline, no window
node bin/cli.js route-check --json                       # routing decision; reads cached rows.json (<10min old) or probes and refreshes it; --probe forces a probe
node bin/cli.js pick --json                               # route-check + the actual vendor/tier/command to run
node bin/cli.js run auto BRIEF.md --cd /path/to/repo       # policy-aware, picks a vendor and hands off on exhaustion
node bin/cli.js handoff /path/to/out-dir codex sol --cd /path/to/repo   # continuation brief to another vendor
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
- **Model policy is an allowlist** (`lib/models.js`, `STRICT_VENDORS`): codex = `gpt-6.1-sol` only (tiers `sol-low`/`sol`/`sol-high` = effort low/medium/high; `gpt-6-astra` via explicit `astra` tier, critical 2D/3D/visual design work only); claude = `claude-sonnet-5-5` / `claude-opus-5-5`. Removed tiers and raw slugs outside the list throw; codex `--effort` must be `low|medium|high` (astra: `high` only, and only with `--critical`); resume remaps stale recorded models to the allowed tier of the same size class (claude opus→opus-5-5, sonnet/haiku→sonnet-5-5; codex luna→sol-low, terra→sol, old sol/astra→sol-high). The critical guard judges the effective (model, effort) pair (`selectionClass` in `lib/models.js`, using the spawned model slug). No passthrough prefixes for codex/claude. **Full access gate:** `--yolo` on EVERY vendor only on class `large` (`yoloCheck` in `lib/models.js`, enforced in `guard.enforce`): codex sol-high / sol+effort high / astra (`-s danger-full-access`), claude opus, opencode glm/kimi, agy opus, grok best; Cursor has no frontier tier and refuses every `--yolo` launch; agy defaults to `--mode accept-edits` (the legacy Antigravity gotcha below is superseded), with bypass only through gated `--yolo`; refused elsewhere on run/resume/handoff/auto; every elevated launch logs `ELEVATED:` (with the real per-path flag) and sets `meta.elevated`; elevated astra needs `--critical` on every launch incl. resume. Callers pass `enforce()` the resolved tier name, NEVER the session id (on resume an unknown tier is `''`). Codex `resume` ALWAYS pins `-c sandbox_mode=` (`--full` only drops clean-room flags; a user profile setting `sandbox_mode` may override the pin, so keep profiles free of it). `test/index.js` must `require` every `*.test.js` (the yolo suite was once missing from `npm test`). The CLI cannot verify user approval; the delegate-* skills require the main agent to ask the user before every `--yolo` launch. **OpenCode tiers:** `free` (small, never critical, never yolo) / `glm` (opencode-go/glm-5.3, large, CRITICAL_TIER) / `kimi` (opencode-go/kimi-k3, large); raw slugs: `*-free` small, the explicit `OPENCODE_LARGE_MODELS` allowlist (glm-5.3, glm-5.2, kimi-k3, kimi-k2.7-code) large, everything else standard (new frontier slugs must be added by hand). OpenCode `--critical` needs class large and `--allow-small` never overrides it (unknown/unrecorded resume model refused). claude/opencode class comes from tier/model only, `--effort` never changes it. Vendor names are normalized by `canonicalVendor` (trim, lowercase, antigravity->agy) everywhere (`--self`, priority entries). **Install mains:** `--main` takes a comma list (claude,codex,cursor,opencode,all); each main's skills dir gets `delegates` + selected delegates minus its own vendor. Foreign skill backups live outside skill roots at `installHome()/backups/<main>/<name>.bak-<ts>` (the legacy install note below is superseded). Change the policy only by editing the maps in `lib/models.js` (+ docs/tests).

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
  the thread was recorded with (and, since 2026-10, a missing/removed recorded model pins the policy
  default gpt-6.1-sol, never Codex's own default). Fixed 2026-09-18 (`lib/runner.js`'s `resolveResumeModel`, applied
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
  against `--cd`/`--add-dir` actually refuses. `resume` refuses exactly like `run` (reversed 2026-10: the old
  "resume never refuses" rationale lapsed once `resume --tier/--model/--effort` could pin the
  model) — `enforce()` judges the effective (model, effort) class and the refusal prints the resolved model, not
  the id passed in place of a tier, plus how to pin a large one. The model can be pinned on a resumed thread with `resume --tier T` or
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
  the latter. Skills: `install` links `delegates` plus only `delegate-<vendor>` for the selected `--delegates`
  and prunes previously-linked delegate skills no longer selected (only symlinks resolving into
  `installHome()/pkg`, via `removeManagedLink`; foreign entries are never touched).
  `--uninstall` removes the shims (if ours) and the whole `installHome()/pkg` copy, and removes a skills
  dir (e.g. `~/.config/opencode/skills`) only when it just removed our links from it AND it is empty
  afterwards (never a non-empty dir); it never touches `routing.json`. While linking, a foreign
  (non-managed) symlink or real dir at a target path is renamed to `<name>.bak-<ts>`, never unlinked.
  `status`/`run auto` probe only claude + the vendors in routing.json `priority` (`status --all` = all rows).
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

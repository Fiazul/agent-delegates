# agent-delegates

Run Codex, Antigravity, Grok Build, Claude Code, Cursor, and OpenCode workers
in reusable terminal windows. Give a worker a brief, follow up in the same
conversation, and collect its report and execution artifacts.

## Website

https://fiazul.github.io/agent-delegates/

## Install

Requires Node.js 18+, npm, and Git for GitHub installation. Vendor CLIs can be
installed during setup or supplied on PATH; authentication is a separate step.
No runtime npm dependencies, Python, jq, or build step required.

The main agent can be Claude Code, Codex, or Cursor; pick it with `install --main`.
Workers can be any of the six vendors, including another Claude.

**Primary (durable global CLI):**

```sh
npm install -g github:Fiazul/agent-delegates
agent-delegates install
```

In a terminal (and without `--yes`), `install` asks two questions before doing
anything:

```
Which CLI is your main orchestrator? [1] Claude Code [2] Codex [3] Cursor [4] all (default 1):
Which delegates do you want? [1] Antigravity [2] Codex [3] Grok [4] Claude [5] Cursor [6] OpenCode — space-separated numbers (default: 1 2 3):
```

**Q1 (main orchestrator)** decides where skills get linked — `claude` →
`~/.claude/skills`, `codex` → `$CODEX_HOME/skills` (default `~/.codex/skills`
when `CODEX_HOME` is unset — never `~/.agents/skills`, which codex never
reads), `cursor` → `~/.cursor/skills`,
`all` → all three (the old default behaviour). The chosen main CLI must
already be installed (this tool wires skills/hooks for it, it doesn't install
an IDE/CLI); if it's missing, `install` stops with a clear error instead of
guessing. The Claude Code statusline and routing-nudge hooks are Claude
Code–specific, so they're only installed when the main is `claude` or `all`
(one line explains this when a Codex/Cursor-only main is chosen) — `--no-statusline`/`--no-hook`
still opt out even then. Non-interactively (no TTY, no `--main`), the default
is `claude`. Override with `--main claude|codex|cursor|all`.

**Q2 (delegates)** decides which vendor CLIs get checked/offered for install
(unselected vendors are never mentioned), sets `priority` in
`~/.config/delegates/routing.json` (used by `run auto`/`pick`/the routing
hooks) to the order chosen, and — once the login check below has run — prints
a `Next: authenticate — …` checklist of login commands for whichever picked
vendors still need attention (empty when everything already checked out
logged in). Answering Q2 (or passing
`--delegates`) always writes `priority`, even if you pick the same vendors as
the default — the *default* itself is silent about `priority` (a fully
non-interactive `install` with no `--delegates` never touches an existing
`priority` you've set by hand). Non-interactively, the default is
`agy,codex,grok`. Override with `--delegates v1,v2,...` (comma-separated:
`agy`, `codex`, `grok`, `claude`, `cursor`, `opencode`).

Either way, `install` also checks for the selected vendor CLIs. In an
interactive terminal, it shows the official install command for each missing
CLI and asks before running it; the default answer is no. Use `--yes` to
install all missing CLIs in an automated setup (and skip both questions
above, using their defaults), or `--skip-cli-install` to link skills without
checking vendor CLIs.
Existing CLIs are left alone. `--uninstall` removes this package's skill
links, aliases, and the routing-nudge hooks (the `~/.claude/agent-delegates-nudge.js`
stub, its `~/.claude/agent-delegates-nudge/` copy dir, and the matching
UserPromptSubmit/PreToolUse entries in `settings.json`); it never checks for
or installs vendor CLIs, and never touches `routing.json` — that file is your
own config. It deliberately leaves the statusline in place (non-destructive
uninstall) — to remove it by hand, delete
`~/.claude/agent-delegates-statusline.js` and set `settings.statusLine` back
to whatever `install` saved as `downstream` in
`~/.claude/delegate-statusline.json`.

Non-interactive installs do not prompt or hang. Without `--yes`, they print the
commands needed and leave setup partial. After any install (and for an existing
CLI), `install` runs the same per-vendor login check `run` uses before every
job and reports one of three honest states per vendor:

- `<cli>: found, logged in.` — a deterministic marker confirms it (codex/grok's
  `auth.json`, opencode's `auth.json`, cursor's `agent status`, or
  `claude auth status`'s `loggedIn: true`).
- `<cli>: found, NOT logged in — run '<login command>'.` — the same check
  positively confirms it is *not* logged in.
- `<cli>: found; login status could not be verified — run '<login command>'
  if a job fails with an auth error.` — the check itself couldn't get a clean
  answer (CLI missing, timed out, or unparseable output). Antigravity is
  checked with the read-only `agy -p /usage` call: usage groups back means
  logged in, an authentication error means logged out.

In an interactive terminal (and without `--yes` or `--no-login`), a
`NOT logged in` result is followed by `Log in to <cli> now? [Y/n]`; answering
yes runs the vendor's own login command interactively and re-checks. Use
`--no-login` to print the checklist without ever prompting. The closing
`Next: authenticate — …` line lists only the vendors still logged out or
unverified after this step; it's omitted once everything checks out.

The commands use the vendors' published installers: [Codex npm package](https://www.npmjs.com/package/@openai/codex),
[Antigravity CLI](https://antigravity.google/cli/install.sh),
[Grok CLI](https://x.ai/cli/install.sh), [Claude Code](https://claude.ai/install.sh),
[Cursor CLI](https://cursor.com/install), and [OpenCode](https://opencode.ai/install).
On Windows, Antigravity, Claude, and Cursor use their published PowerShell
installers. Grok and OpenCode Windows installer URLs are not verified, so the
CLI prints manual guidance instead of guessing.
Unsupported operating systems receive manual-install guidance and no download is attempted.
Existing non-link directories are backed up as `<name>.bak-<timestamp>`.
The global install survives npm cache pruning.

**Try-it-once (npx):**

```sh
npx --yes github:Fiazul/agent-delegates install
```

`--yes` skips the setup questions below and installs all missing vendor CLIs
without prompting (useful for a one-shot try-it, or any non-interactive
context). `npx` is ephemeral — the checkout it runs from can be pruned any
time — so `install` never leaves anything pointing at it. Its first step
copies the package (`bin/`, `lib/`, `skills/`, `extras/`, `package.json`,
`README.md`, `LICENSE`) into a stable install home:

- POSIX: `~/.agent-delegates/pkg`
- Windows: `%LOCALAPPDATA%\agent-delegates\pkg` (falls back to
  `%USERPROFILE%\.agent-delegates\pkg` when `LOCALAPPDATA` isn't set)

Every artifact `install` writes after that — the skill symlinks, the
statusline and `UserPromptSubmit`/`PreToolUse` hook copies, and the command
below — references this copy, never the transient location the installer
happened to run from. Re-running `install` (e.g. `npx --yes
github:Fiazul/agent-delegates install` again after an upgrade) replaces the
copy fresh each time, so it always reflects the current package. Running the
already-installed copy's own `install` (e.g. after `npm install -g`) is a
no-op for this step — there's nothing to copy onto itself.

The last step puts the `agent-delegates` command on PATH as a real shim
(never a shell alias — aliases don't exist in the non-interactive shells most
agent tooling spawns, which was the actual bug this replaces: `agent-delegates
status` from a script or another tool's Bash tool used to fail with `command
not found`):

- POSIX: executable shims at `~/.local/bin/agent-delegates` and
  `~/.local/bin/delegates`, each `exec`'ing the copied `bin/cli.js`. If
  `~/.local/bin` isn't already on PATH, `install` prints the `export PATH=...`
  line to add it.
- Windows: `agent-delegates.cmd` and `delegates.cmd` in
  `%LOCALAPPDATA%\agent-delegates\bin`; if that directory isn't on your user
  PATH, an interactive terminal asks before adding it via `setx` (never the
  machine-wide PATH) — `--no-path` skips the prompt and just prints the
  instruction, and a non-TTY run always just prints it.

A shim is only ever written or removed if it already carries agent-delegates'
own marker comment — a foreign file at the same path is left alone with a
warning, never overwritten or deleted.

Replace `agent-delegates` with `npx github:Fiazul/agent-delegates` in all
commands below when not globally installed, or once installed, use the
`agent-delegates` command directly from any shell. Reinstall to update.
Remove installed links, the shim, and the copied package with
`agent-delegates install --uninstall`; skill-link backups are retained,
and `routing.json` is never touched.

### Cursor and Grok both install `agent`

Cursor's CLI and Grok's CLI both put a binary literally named `agent` on
PATH (Grok's installer even puts it right next to its own `grok` binary as a
second name for the same file). `agent-delegates` itself is unaffected by
this — it never calls the bare `agent` name; it resolves Cursor via
`cursor-agent` and Grok via `grok` explicitly (`lib/bins.js`), and persists
whichever absolute path it resolved for every selected delegate into
`~/.config/delegates/routing.json`'s `bins` key (an existing `bins.<vendor>`
entry is kept as-is as long as that file still exists — it's never silently
re-resolved out from under you).

Resolution order, highest priority first: a `DELEGATE_<VENDOR>_BIN` env var
override (`DELEGATE_CURSOR_BIN`, `DELEGATE_GROK_BIN`, `DELEGATE_CODEX_BIN`,
`DELEGATE_AGY_BIN`, `DELEGATE_CLAUDE_BIN`, `DELEGATE_OPENCODE_BIN`), then the
persisted `routing.json` `bins.<vendor>` entry, then a fresh PATH lookup.
Every job prints `BIN: <command> (<source>)`; when the resolved binary's
identity can't be confirmed (e.g. a `--version`/self-check probe failed or
was skipped) the line prints `BIN: <command> (<source>) [unverified]` instead
of silently trusting an unconfirmed binary.

Your own shell is a different story: if both are installed, whichever `agent`
comes first on your `PATH` silently decides what a bare `agent -p` runs. But
that's only a problem when it decides wrong: **it's a conflict only when
something (Grok, or an unrecognized binary) shadows Cursor's `agent`** — if
Cursor's own `agent` already wins PATH resolution, or Cursor isn't installed
at all, `install` says nothing and touches nothing, no matter how many other
`agent` launchers exist further down PATH (at most one plain `NOTE:` line if
a harmless duplicate is sitting there shadowed). When `install` selects both
`cursor` and `grok` (as a delegate, or `cursor` as `--main`) and finds a real
conflict, it prints a loud block explaining it and, when the duplicate is a
plain symlink safely traceable back to the vendor's own canonical binary in
the same directory (never a regular file — that could be someone's real
launcher), offers to rename it aside:

```
CONFLICT: two tools on this system both provide a command named "agent"
  /home/x/.local/bin/agent  → Cursor (cursor-agent)
  /home/x/.grok/bin/agent   → Grok (grok)
Whichever comes first on PATH wins, so "agent -p" may launch the wrong tool.
agent-delegates itself is safe: it calls cursor-agent and grok directly.
Proposed fix for your shell: keep "cursor-agent" for Cursor and "grok" for Grok, and remove the duplicate "agent" launcher(s) — they are plain symlinks to the same binaries, nothing is uninstalled.
  would remove: /home/x/.grok/bin/agent  (duplicate of /home/x/.grok/bin/grok)
Apply this rename now? [y/N]
```

The headline changes to `CONFLICT: installing <vendor> added a second "agent"
launcher` when the collision is brand new (this `install` run just installed
the vendor that caused it) rather than something that already existed. The
default answer is always **No**; declining prints a one-line reassurance and
changes nothing. Accepting **renames** the duplicate symlink to
`<name>.agent-delegates-bak` next to itself — nothing is deleted, and nothing
is truly "uninstalled" (rename it back to restore it). Non-interactively,
pass `--resolve-agent-conflict yes` to apply it without asking, or `no` to
skip it explicitly; without either, a non-TTY run prints the block and does
nothing.

Separately, opt-in shell convenience: `install` can add `cursor-agent`/`grok`
aliases to your `.bashrc`/`.zshrc` pointing at the resolved binaries (asked
interactively, or `--aliases yes|no`). These are marked with a `# agent-delegates`
comment so `--uninstall` removes exactly these lines and nothing else you wrote.

### Per-OS behaviour

| OS | Terminal used | Skill links | Untested |
|----|---------------|-------------|----------|
| **Linux** | gnome-terminal → x-terminal-emulator → konsole → xterm → tmux | symlinks | — |
| **macOS** | Terminal.app (osascript) | symlinks | terminal launch, path handling |
| **Windows** | Windows Terminal (wt.exe) → cmd window | junctions; copies with a note if junctions fail | terminal launch, path handling, junction behaviour |

macOS and Windows terminal integration paths were written but have not been
tested on real hardware.

### Claude statusline

`install` installs the statusline by default (opt out with `--no-statusline`;
`--statusline` is accepted too, but is already the default so it's a no-op).
It copies a standalone Node helper to `~/.claude` and configures
`settings.json` with a command of the form:

```text
node "/absolute/path/.claude/agent-delegates-statusline.js"
```

The same command works on Windows without Bash or PowerShell scripts. It writes
`~/.claude/rate_limits.json` from Claude's stdin snapshot, then invokes any
previously configured statusline command with the same input. Otherwise it shows
a minimal quota line. Uninstall leaves this independent helper and settings in
place.

## Commands

```sh
agent-delegates status                                       # quota table
agent-delegates status --probe-grok                          # refresh Grok (tiny paid call)
agent-delegates run codex luna BRIEF.md --cd "/path/to/repo"
agent-delegates resume codex THREAD_ID FOLLOWUP.md --cd "/path/to/repo" [--tier T | --model M]
agent-delegates interrupt codex
agent-delegates close codex
agent-delegates --help
```

Vendors are `codex`, `agy` (alias `antigravity`), `grok`, `claude`, `cursor`,
and `opencode`. Use `--name N` on run/resume for a named window, then
`interrupt N` or `close N`.
A brief filename of `-` reads stdin. Always repeat `--cd` on resume.

**Resume model:** `resume` reuses the model recorded by the original run. Use
`--tier T` or `--model M` to pin another one (`--tier` wins); without a record,
it prints `WARNING:` and uses the vendor default. These flags are errors on
`run`, where the tier/model is positional.

Writing a brief: start from
[`skills/delegate-codex/brief-template.md`](skills/delegate-codex/brief-template.md).
A brief without Goal, Scope out, and Acceptance criteria produces a worker
that guesses.

### Skills and tiers

| Skill | Tiers |
|-------|-------|
| delegate-codex | luna, terra, sol, astra |
| delegate-antigravity | lite, flash, pro, sonnet, opus |
| delegate-grok | fast, best |
| delegate-claude | haiku, sonnet, opus |
| delegate-cursor | auto, composer |
| delegate-opencode | free, go |
| delegates | Remaining quota and models for all six vendors |

The skill documents list model mappings, permission semantics, and
orchestration guidance.

### Run options

| Flag | Scope | Effect |
|------|-------|--------|
| `--cd DIR` | all | working directory |
| `--name N` | all | reusable window name |
| `--effort E` | all | model reasoning effort |
| `--add-dir D` | all | extra working directory (repeatable) |
| `--ro` | Codex | read-only sandbox |
| `--full` | Codex | user configuration instead of clean room; repeat on resume |
| `--safe` | agy | accept-edits mode (default is full permission) |
| `--yolo` | Grok, Claude, Cursor, OpenCode | full permission mode |
| `--critical` | all | mark this brief as critical work (prod/servers/live data): a large-tier model is required (see "Critical work and permissions") |
| `--allow-small` | all | override the critical-work guard and allow a small/standard model (not recommended) |
| `--timeout MIN` | all | kill the worker after `MIN` minutes and classify the job "timed out" (default 90, env `DELEGATE_JOB_TIMEOUT_MIN`); exit code 124 |
| `--no-preflight` | all | skip the pre-spawn login check for the vendor CLI |
| `--json` | route-check, pick | print one JSON line instead of a human-readable line |
| `--self VENDOR` | route-check | whose routing policy to report (only `claude` supported today) |
| `--priority v1,v2,...` | run auto | vendor try-order (default `agy,codex,grok,cursor,opencode,claude`) |
| `--max-hops N` | run auto | max vendor hand-off attempts (default 2) |

Codex uses `workspace-write` (or `--ro`), with an auth-only `~/.codex-fresh`
home. Codex never uses the sandbox-bypass flag.

Antigravity defaults to `--dangerously-skip-permissions` because headless
`accept-edits` auto-denies shell commands. `--safe` selects accept-edits.

Grok's `--yolo` selects `--always-approve`. Claude defaults to `acceptEdits`;
`--yolo` enables `--dangerously-skip-permissions`. Cursor's `--yolo` selects
`--force`. OpenCode's `--yolo` selects `--auto`. Scope briefs to the intended
files and operations.

**Job timeout:** every `run`/`resume` job is killed after `--timeout` minutes
(default 90; override with the env var `DELEGATE_JOB_TIMEOUT_MIN` when no
`--timeout` flag is given). A killed job exits 124 and is classified "timed
out" (`lib/failure.js`), same as any other failure — `run auto`/`handoff`
treat it like a non-quota failure (it does not trigger a hop).

**Job lifecycle:** after a worker prints its terminal event, it gets 20 seconds
to exit; otherwise the launcher kills its process tree and classifies from the
events (a successful stream exits 0). Set `DELEGATE_TERMINAL_GRACE_MS` (`0` disables);
each later stream event re-arms the grace timer. Ctrl-C, SIGTERM, and SIGHUP kill
the whole worker tree; `interrupt` first verifies the recorded pid is still that worker.

**Vendor option differences:** Codex resume pins its model with `-c model=<slug>`
and sandbox with `-c sandbox_mode=` plus `--ignore-user-config` (unless `--full`),
and passes `--effort`; it warns that
`--add-dir` is unsupported. Cursor passes `--add-dir`; Grok/OpenCode warn when
it is unsupported; OpenCode maps `--effort` to `--variant`.

**Preflight login check:** before submitting a job, `codex`/`grok`/`cursor`/
`opencode` get a cheap local check that the vendor CLI is actually logged in,
so a job doesn't fail minutes later on an auth error. `claude` and `agy` are
always skipped (neither has a deterministic local check — see `lib/status.js`
`preflight()`). `cursor`'s check fails **open**: anything short of a clean
"not authenticated" answer (missing binary, timeout, unparseable output) lets
the run proceed rather than blocking it. `--no-preflight` skips the check
entirely for any vendor.

### Quota table

Status shows CLI, LEFT, and MODELS columns. Example:

```
CLI     LEFT                                                    MODELS
claude  wk 62% · 5h 100%                                       fable-5.1 opus-5 sonnet-5 haiku-4.5
codex   wk 85% (reset 134h) · 5h 100%                          gpt-5.6-luna gpt-5.6-terra gpt-5.6-sol gpt-6-astra
agy     gemini wk 43% · claude/gpt wk 100%                     gemini-3.8-flash{l/m/h} gemini-3.1-pro{l/m/h} ...
grok    logged in · quota via --probe-grok                     grok-4.5 grok-4.6
cursor  included 85% left · resets Oct 16 (auto 85% · api 91%) auto composer-2.5 ...
```

Claude needs a statusline snapshot; Codex queries its local auth (`chatgpt.com/backend-api/wham/usage`);
agy uses `/usage` and `models`; Grok uses the last-402 marker — there is no
read-only account-balance endpoint to poll (only a real, billable call can
confirm the weekly budget; see `--probe-grok`); Cursor calls the same
Connect-RPC endpoint its own `/usage` TUI screen uses
(`aiserver.v1.DashboardService/GetCurrentPeriodUsage` on `api2.cursor.sh`,
plain JSON over HTTPS POST, bearer token from `~/.config/cursor/auth.json`) —
falling back to `cursor-agent status`'s `logged in · no quota API` on any
HTTP failure so the row never throws; OpenCode uses auth-file presence plus
`opencode models`. Credentials and email addresses are never displayed.

## Auto routing and cross-vendor handoff

```sh
agent-delegates run auto BRIEF.md --cd "/path/to/repo"
agent-delegates run auto BRIEF.md --priority agy,codex,grok --cd "/path/to/repo"
agent-delegates run auto BRIEF.md --max-hops 1 --cd "/path/to/repo"
agent-delegates handoff /path/to/out-dir codex terra --cd "/path/to/repo"
```

`run auto <brief-file|->` picks the first vendor with quota from a priority
list, judged from the same status-row text `agent-delegates status` prints
(installed, logged in, quota left), and runs the brief there. Default order
is `agy, codex, grok, cursor, opencode, claude` — claude last because a
missing rate-limit snapshot reads as "unknown" and is treated as usable, so
it would otherwise mask real exhaustion upstream. `--priority` overrides the
order (comma-separated vendor ids). `run auto` uses each vendor's own
default tier — agy flash, codex terra, grok best, claude sonnet, cursor auto,
opencode free — on both the initial run and every hop, **unless the brief is
critical** (explicit `--critical`, or a `guard.paths` match against
`--cd`/`--add-dir`), in which case it uses the vendor's large `CRITICAL_TIER`
instead (see "Critical work and permissions" below) and drops vendors with
no large tier from the try-order. There is no other per-run tier override,
since the vendor isn't chosen until `pickVendor` runs and a tier name from
one vendor's tier map means nothing on another vendor's.

Unknown quota (a status row that can't confirm remaining quota one way or
the other) is treated as usable for some vendors and unusable for others:

| Vendor | Unknown-quota row text | Usable? |
|--------|-------------------------|---------|
| codex | `usage unavailable` | yes (unknown) |
| grok | `logged in · quota via --probe-grok` | yes (unknown) |
| opencode | `logged in · no quota API` | yes (unknown) |
| agy | `usage unavailable` / no gemini bucket | no (can't confirm) |
| cursor | `logged in · no quota API` (no token, or the usage API was unreachable) | yes (unknown) |
| cursor | `included N% left ...` with `N` confirmed | usable iff `N > 0` |
| cursor | `unavailable` / `logged out` / `missing` | no (can't confirm) |

**Hop rule: only quota exhaustion hops.** If the chosen vendor's run comes
back exhausted (or fails for a quota-shaped reason — 429/402/rate-limit/quota
text), `run auto` picks the next usable vendor from what's left and hands the
job to it via `handoff`, printing `AUTO: <vendor> exhausted → handing off to
<next>`. A non-quota failure (a bad brief, a bug the worker hit) never hops —
it stops and returns that result, since burning two more vendors' quota won't
fix a bug. `--max-hops N` caps how many times it will hop (default 2); once
no usable vendor remains, or the cap is hit, it returns the last result as-is.

If an invocation throws (for example a missing binary, preflight failure, or
exit 127), `run auto` prints `AUTO: <vendor> skipped — <reason>` and tries the
next vendor; a vendor with no resolvable binary is never chosen. A hop says
`unavailable` for this case and `exhausted` only for a quota failure.

`handoff <job-dir> <vendor> [tier] --cd DIR` builds a continuation brief for
`<vendor>` from a finished job directory and starts a fresh job there. The
continuation brief includes: the original brief text, the failure
reason/classification from that job, `git status`/diff-stat for the working
tree at handoff time, and the last worker message (`last.md`). This is
**observable state only** — the failed worker's internal reasoning (why it
chose an approach, what it considered and rejected) isn't in the job
directory and can't be reconstructed, so the new vendor picks up from what
changed on disk and what was said, not from a transcript of how it got
there.

## When does the orchestrator delegate? (routing policy)

Only the main agent (the orchestrator) consults this; workers never see it, by
design. `lib/policy.js` decides `external` vs `stay` from the main agent's own
quota snapshot and a small config file. Today the only snapshot source is
Claude Code's (`~/.claude/rate_limits.json`, written by the statusline), so
the pace rule is active when the main is Claude Code; a Codex or Cursor main
still gets `status`/`pick`/`run auto` vendor selection, just without a pace
rule of its own (`route-check --self codex` is the open item).

At most **3 workers** may run at once across all vendors, Claude subagents,
and reviewers, unless the user asks for more. Count live workers before spawn
and wait or queue work at the cap.

- **POSIX:** `~/.config/delegates/routing.json`
- **Windows:** `%APPDATA%\delegates\routing.json`

Defaults (missing/invalid file, or a partial file merged over these):

```json
{
  "mode": "pace",
  "threshold": 40,
  "slack": 10,
  "slack5h": 15,
  "fiveHourCap": 80,
  "hardCap": 70,
  "staleMinutes": 10,
  "priority": ["agy", "codex", "grok", "cursor", "opencode", "claude"]
}
```

- **`mode: "fixed"`** — route external once weekly usage% >= `threshold`.
- **`mode: "pace"`** (default) — compute how far into the 7-day window
  `now` is (`elapsedPct`, from `seven_day.resets_at`) and go external if
  weekly usage% is more than `elapsedPct + slack` points ahead of pace, OR
  the weekly bucket is at/over `hardCap` regardless of pace, OR the 5-hour
  bucket is at/over `fiveHourCap` (a hard floor), OR the 5-hour bucket is
  more than `elapsedPct + slack5h` ahead of its own pace within the current
  5-hour window (from `five_hour.resets_at`; skipped entirely if that's
  missing) — the same pace idea applied to the shorter window, to catch a
  burst that would blow the 5-hour bucket well before the weekly one
  notices. Falls back to `mode: "fixed"` if `seven_day.resets_at` is missing
  from the snapshot.
- If the snapshot is missing or older than `staleMinutes`, the route is
  `unknown` (stay in-house, but say the data is missing/stale) rather than
  guessing either way.
- If the policy would say `external` but no external vendor currently has
  quota (checked via `status`'s row logic), it stays on `claude` instead —
  never routes to a wall.

`route-check`, `pick`, and `run auto` read a cached vendor-status snapshot
(`~/.cache/delegates/rows.json`, `%LOCALAPPDATA%/delegates/rows.json` on
Windows) when it's younger than `rowsTtlMinutes` in `routing.json` (default
10 minutes); otherwise they probe vendors and refresh it. `status` always
probes and refreshes the cache. Pass `--probe` to force a fresh probe
regardless of cache age:

```sh
agent-delegates route-check
agent-delegates route-check --json
```

```
route=claude  wk 3% used · 5h 21% · 6.9% of week elapsed · reason: wk 3% used vs 6.9% of week elapsed (+10 slack); within pace  next=codex
```

`--json` prints one line: `{route, reason, claudeWk, fiveHour, elapsedPct, stale, nextVendor}`.
`--self claude` is accepted (and is the only value supported today); any
other vendor prints "unsupported, reports claude policy" and still reports
Claude's policy — the flag exists so a future `--self codex` has a stable
place to land (see TODO.md).

### `pick`: the one-line pre-spawn decision

The orchestrator runs `agent-delegates pick --json` before every spawn and
follows it. Unlike `route-check` (which only reports the policy), `pick`
also chooses the actual vendor/tier and hands back the exact command to run.
Pass `--critical` for production/servers/live-data work — it restricts the
vendor choice to one with a `CRITICAL_TIER` (see "Critical work and
permissions" below) and adds `--critical` to the suggested command.

```sh
agent-delegates pick
agent-delegates pick --json
agent-delegates pick --critical --json
```

Four possible JSON shapes:

```json
{"route":"claude","reason":"wk 3% used vs 6.9% of week elapsed (+10 slack); within pace","suggest":"do the work in-house"}
{"route":"unknown","reason":"no Claude quota snapshot","suggest":"do the work in-house"}
{"route":"external","vendor":"agy","tier":"flash","critical":false,"reason":"wk 60% used vs 14% of week elapsed (+10 slack)","command":"agent-delegates run agy flash BRIEF.md --cd <dir>"}
{"route":"none","reason":"all external vendors exhausted or logged out; stay in-house","suggest":"do the work in-house"}
```

`route:"claude"`/`"unknown"` mean stay with the main agent and do the work
in-house. `route:"external"` means run the given `command`.
`route:"none"` means the policy wanted external but nothing usable is
actually standing (everything exhausted/logged out, or — under
`--critical` — nothing left with a large-enough tier after filtering), so
it falls back to the main agent too.

### The hook is advisory

`agent-delegates install` ships a `UserPromptSubmit` hook and a `PreToolUse`
hook by default (opt out of both with `--no-hook`) that run this same
policy — `UserPromptSubmit` once at the top of the turn, `PreToolUse` again
right before an `Agent` tool call or an `agent-delegates run`/`claude `
`Bash` command, to catch a quota crossing that happens mid-turn — and,
only when the route is `external`, inject a short reminder into context
naming the routing rule and `agent-delegates pick --json`. Neither hook ever
blocks a tool call or prints anything when the route is `claude`. The hook
is advisory, not enforcement: if it conflicts with your own rules, disable
it with `--no-hook` at install time, or set `mode: "fixed"` and
`threshold: 100` in `routing.json` so it never fires. `run auto` also
consults this policy itself (`respectPolicy: true` by default) — if it says
stay in-house, it does not delegate for that run.

## Critical work and permissions

A shared guard (`lib/guard.js`) refuses to run **critical** work (production/destructive-shaped
tasks) on a small or standard model on `run`, `run auto`, and `handoff`. **`resume` never
refuses** — a resumed thread's model was already fixed when the thread was created, so there is
no tier left to refuse; `resume` only warns (see "What you'll see" below).

**Which tiers pass on critical work** — only `large`-class tiers; `cursor` and `opencode` have
none, so they're refused outright unless `--allow-small`:

| Vendor | Large tier used | `--allow-small` still refuses? |
|--------|-----------------|-----------------------------------|
| codex | `sol` (or `astra`) | no — either passes |
| agy | `opus` | no |
| claude | `opus` | no |
| grok | `best` | no |
| cursor | *(none)* | no* |
| opencode | *(none)* | no* |

\* `--allow-small` still overrides the refusal and lets the run proceed — it just has no large
tier to promote to, since this vendor never has one.

**How criticality is detected, and what each detector does** (`assessCriticality`):
- `--critical` passed explicitly on the CLI, **or** the working directory/an `--add-dir` matches
  a glob in `routing.json`'s `guard.paths` (supports `*` and `**`; `/srv/prod/**` also matches
  `/srv/prod` itself, not just paths under it) — either one **refuses** a non-large tier (subject
  to the table above and `--allow-small`). Relative `--add-dir`/`--cd` values are resolved to
  absolute paths before matching.
- A keyword heuristic over the brief text against `routing.json`'s `guard.keywords`, or a
  built-in default list (`production`, `deploy`, `kubectl`, `terraform`, `migrate`, `DROP TABLE`,
  `rm -rf`, `secrets`, `payment`, `billing`, `customer data`, `live server`, etc. — see
  `lib/guard.js` `DEFAULT_GUARD` for the full list) — this one is **advisory only**
  ("suspected", not "critical"): the worker's prompt gets a softened caution ("this brief *may*
  touch production/critical systems... heuristic guess, not confirmed") instead of the full
  critical-work note, and it never blocks a small/standard-tier run by itself. Treat it as
  "double-check this brief," not as a gate — only `--critical` or a `guard.paths` match actually
  refuses.

Both `guard.paths` and `guard.keywords` live under the same
`~/.config/delegates/routing.json` used by the routing policy above:
```json
{ "guard": { "paths": ["/srv/prod/**"], "keywords": ["custom-term"] } }
```

**What you'll see:**
- `invoke()` prints `CRITICAL: <reasons>` and a `PERMISSIONS: <mode>` line before running when
  `--critical`/a `guard.paths` match fired. When only the keyword heuristic fired, it prints one
  `CRITICAL? <hint> — pass --critical if this touches live systems` line per hint (max 5) and
  injects a softened caution into the worker's own prompt; the run is never refused.
- A refused run (`--critical`/`guard.paths` only, non-`resume`) prints a `CRITICAL WORK (...):
  <vendor> <tier> is a <class> model; ...` error and never submits the job (no output directory
  written).
- `resume` on critical work never refuses; it prints a warning instead, since the model was
  already chosen at thread creation.
- Full-bypass permission modes print an extra `WARNING: critical work with full bypass
  permissions on <vendor>; ...` line.

**Default permission mode per vendor** (`lib/guard.js` `permissionMode`): `codex` is always
sandboxed (`workspace-write`, or read-only with `--ro`) and never gets a bypass flag. `agy` runs
with full bypass (`--dangerously-skip-permissions`) by default — pass `--safe` to restrict it to
accept-edits. `claude` defaults to `acceptEdits`; `cursor` defaults to trust-workspace (no
`--force`); `grok` and `opencode` default to approval prompts. `--yolo` grants full bypass on
`claude`, `cursor`, `grok`, and `opencode` (it has no effect on `codex`, and `agy` uses `--safe`
instead of `--yolo`).

**`--allow-small`** overrides the tier refusal (not recommended) — the run proceeds on whatever
tier was asked for, but still prints the bypass warning if applicable. It does not suppress the
`CRITICAL:`/`PERMISSIONS:` lines.

**`run auto` and `handoff` on critical work:** `run auto` assesses criticality once up front from
the brief text and `--cd`/`--add-dir`; if critical (`--critical` or a `guard.paths` match, and
`--allow-small` wasn't given), it uses each vendor's `CRITICAL_TIER` instead of its default tier
for the first attempt and every hop, and drops `cursor`/`opencode` from the try-order entirely,
printing `AUTO: critical work — large models only; skipping cursor, opencode`. With
`--allow-small` it behaves like non-critical work (default tiers, nothing skipped) but prints
`AUTO: critical work, --allow-small given`. `handoff` reads `critical` off the source job's
`meta.json` (written by `invoke()`) or `options.critical`; if the run didn't pin an explicit
tier, it picks the target vendor's `CRITICAL_TIER` (throwing a clear error if the target has none
and `--allow-small` wasn't given) and passes `critical: true` through so the guard re-checks the
new job too.

**Worker prompt instruction:** on critical runs, `invoke()` injects an extra paragraph into the
worker's prompt: prefer read-only investigation, and before any irreversible action (delete,
migrate, deploy, restart, rotate keys, write to live data) stop and list it under OPEN QUESTIONS
unless the brief explicitly authorizes that exact action.

## Windows and logs

One console per vendor/name shows the brief, model, narrative, tool activity,
and final result. It stays open for reuse and closes after 10 idle minutes.
Interrupt kills the worker process tree; close waits for active work.

| Environment variable | Purpose |
|---|---|
| `DELEGATE_OUT` | Job artifact root; defaults to the system temp directory/codex-workers |
| `CODEX_WORKER_OUT` | Legacy fallback when `DELEGATE_OUT` is unset |
| `DELEGATE_NO_WINDOW=1` | Execute through the queue inline |
| `DELEGATE_IDLE_MIN` | Idle-close minutes, default 10 |
| `DELEGATE_CONSOLE_DIR` | Override console queue/log root |
| `DELEGATE_CURSOR_BIN`, `DELEGATE_GROK_BIN`, `DELEGATE_CODEX_BIN`, `DELEGATE_AGY_BIN`, `DELEGATE_CLAUDE_BIN`, `DELEGATE_OPENCODE_BIN` | Force the resolved binary path/command for that vendor, ahead of `routing.json`'s `bins` entry and PATH lookup |

Console logs live at `~/.cache/delegates/<name>/console.log` on POSIX and
`%LOCALAPPDATA%/delegates/<name>/console.log` on Windows. Each output directory
contains `brief.md`, `prompt.md`, `events.jsonl`, `last.md`, `exit`, `stderr.log`,
and `thread_id` (Codex), `conversation_id` (agy), or `session_id`
(Grok/Claude/Cursor/OpenCode).
The caller receives `out=`, `exit=`, the ID, `usage=`, `open=`, and the final
report. Treat briefs and worker transcripts as private project data.

## Extras

`extras/claude-routing-rule.md` contains cross-vendor routing guidance for a
Claude Code main agent (quota thresholds, tier equivalents, rerouting on
exhaustion).

## Development

```sh
npm test
node bin/cli.js --help
npm pack --dry-run
```

## License

MIT (see LICENSE)

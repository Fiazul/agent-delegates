# agent-delegates

Run Codex, Antigravity, Grok Build, Claude Code, Cursor, and OpenCode workers
in reusable terminal windows. Give a worker a brief, follow up in the same
conversation, and collect its report and execution artifacts.

## Install

Requires Node.js 18+, npm, and Git for GitHub installation. Vendor CLIs can be
installed during setup or supplied on PATH; authentication is a separate step.
No runtime npm dependencies, Python, jq, or build step required.

**Primary (durable global CLI):**

```sh
npm install -g github:Fiazul/agent-delegates
agent-delegates install --statusline
```

This links seven skills into `~/.claude/skills`, `~/.agents/skills`, and
`~/.cursor/skills`. It also checks for the six vendor CLIs. In an interactive
terminal, it shows the official install command for each missing CLI and asks
before running it; the default answer is no. Use `--yes` to install all missing
CLIs in an automated setup, or `--skip-cli-install` to link skills without
checking vendor CLIs.
Existing CLIs are left alone. `--uninstall` only removes this package's links
and aliases; it never checks for or installs vendor CLIs.

Non-interactive installs do not prompt or hang. Without `--yes`, they print the
commands needed and leave setup partial. After any install (and for an existing
CLI), authentication remains unverified: authenticate separately with
`codex login`, `agy`, `grok`, `claude`, `agent login`, or `opencode auth login`
as appropriate. The install process never attempts to log in for you.

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
npx github:Fiazul/agent-delegates install --statusline
```

The links target npm's cached checkout. If the cache is pruned, the symlinked
skills break — prefer the global install for ongoing use.

Replace `agent-delegates` with `npx github:Fiazul/agent-delegates` in all
commands below when not globally installed. Reinstall to update. Remove
installed links with `agent-delegates install --uninstall`; backups are retained.

### Per-OS behaviour

| OS | Terminal used | Skill links | Untested |
|----|---------------|-------------|----------|
| **Linux** | gnome-terminal → x-terminal-emulator → konsole → xterm → tmux | symlinks | — |
| **macOS** | Terminal.app (osascript) | symlinks | terminal launch, path handling |
| **Windows** | Windows Terminal (wt.exe) → cmd window | junctions; copies with a note if junctions fail | terminal launch, path handling, junction behaviour |

macOS and Windows terminal integration paths were written but have not been
tested on real hardware.

### Claude statusline

`--statusline` copies a standalone Node helper to `~/.claude` and configures
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
agent-delegates resume codex THREAD_ID FOLLOWUP.md --cd "/path/to/repo"
agent-delegates interrupt codex
agent-delegates close codex
agent-delegates --help
```

Vendors are `codex`, `agy` (alias `antigravity`), `grok`, `claude`, `cursor`,
and `opencode`. Use `--name N` on run/resume for a named window, then
`interrupt N` or `close N`.
A brief filename of `-` reads stdin. Always repeat `--cd` on resume.

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

Codex uses `workspace-write` (or `--ro`), with an auth-only `~/.codex-fresh`
home. Codex never uses the sandbox-bypass flag.

Antigravity defaults to `--dangerously-skip-permissions` because headless
`accept-edits` auto-denies shell commands. `--safe` selects accept-edits.

Grok's `--yolo` selects `--always-approve`. Claude defaults to `acceptEdits`;
`--yolo` enables `--dangerously-skip-permissions`. Cursor's `--yolo` selects
`--force`. OpenCode's `--yolo` selects `--auto`. Scope briefs to the intended
files and operations.

### Quota table

Status shows CLI, LEFT, and MODELS columns. Example:

```
CLI     LEFT                                   MODELS
claude  wk 62% · 5h 100%                      fable-5.1 opus-5 sonnet-5 haiku-4.5
codex   wk 85% (reset 134h) · 5h 100%         gpt-5.6-luna gpt-5.6-terra gpt-5.6-sol gpt-6-astra
agy     gemini wk 43% · claude/gpt wk 100%    gemini-3.8-flash{l/m/h} gemini-3.1-pro{l/m/h} ...
grok    unknown (--probe-grok)                 grok-4.5 grok-4.6
```

Claude needs a statusline snapshot; Codex queries its local auth; agy uses
`/usage` and `models`; Grok uses the last-402 marker; Cursor uses `agent status`;
OpenCode uses auth-file presence plus `opencode models`. Credentials and email
addresses are never displayed.

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
order (comma-separated vendor ids). `run auto` always uses each vendor's own
default tier — agy flash, codex terra, grok best, claude sonnet, cursor auto,
opencode free — on both the initial run and every hop; there is no per-run
tier override, since the vendor isn't chosen until `pickVendor` runs and a
tier name from one vendor's tier map means nothing on another vendor's.

Unknown quota (a status row that can't confirm remaining quota one way or
the other) is treated as usable for some vendors and unusable for others:

| Vendor | Unknown-quota row text | Usable? |
|--------|-------------------------|---------|
| codex | `usage unavailable` | yes (unknown) |
| grok | `unknown (--probe-grok)` | yes (unknown) |
| opencode | `unknown` | yes (unknown) |
| agy | `usage unavailable` / no gemini bucket | no (can't confirm) |
| cursor | `unavailable` (anything but exact `ok`) | no (can't confirm) |

**Hop rule: only quota exhaustion hops.** If the chosen vendor's run comes
back exhausted (or fails for a quota-shaped reason — 429/402/rate-limit/quota
text), `run auto` picks the next usable vendor from what's left and hands the
job to it via `handoff`, printing `AUTO: <vendor> exhausted → handing off to
<next>`. A non-quota failure (a bad brief, a bug the worker hit) never hops —
it stops and returns that result, since burning two more vendors' quota won't
fix a bug. `--max-hops N` caps how many times it will hop (default 2); once
no usable vendor remains, or the cap is hit, it returns the last result as-is.

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

Console logs live at `~/.cache/delegates/<name>/console.log` on POSIX and
`%LOCALAPPDATA%/delegates/<name>/console.log` on Windows. Each output directory
contains `brief.md`, `prompt.md`, `events.jsonl`, `last.md`, `exit`, `stderr.log`,
and `thread_id` (Codex), `conversation_id` (agy), or `session_id`
(Grok/Claude/Cursor/OpenCode).
The caller receives `out=`, `exit=`, the ID, `usage=`, `open=`, and the final
report. Treat briefs and worker transcripts as private project data.

## Extras

`extras/claude-routing-rule.md` contains cross-vendor routing guidance for
Claude orchestrators (quota thresholds, tier equivalents, rerouting on
exhaustion).

## Development

```sh
npm test
node bin/cli.js --help
npm pack --dry-run
```

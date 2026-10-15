---
name: delegate-codex
description: Use when delegating a task to a Codex (OpenAI) worker — user says "codex", "summon codex", "use sol/astra", wants a second-vendor opinion, or the main agent's quota is low. Codex runs non-interactively via `codex exec`; hangs, wrong model slugs, sandbox git restrictions, and 5-hour usage limits are the usual failures.
---

# Delegate to Codex

Codex-side worker for any main agent. Same orchestration rules: brief with
constraints + acceptance criteria, worker is sole executor, review the diff
afterwards. The launcher prepends the standard worker preamble.

Critical work (`--critical`): only `sol-high`/`astra` allowed (use `sol-high`; `astra` only for visual work below).

## Tier ladder (orchestrator picks)

One model, `gpt-6.1-sol`; the tier sets effort. Size the task, pick the tier.

| Tier | Codex model | Effort | Use for |
|------|-------------|--------|---------|
| `sol-low` | gpt-6.1-sol | low | simple: lookups, formulaic edits |
| `sol` | gpt-6.1-sol | medium | **default** standard build / fix / test |
| `sol-high` | gpt-6.1-sol | high | hard tasks, reviews, critical (non-visual) work |
| `astra` | gpt-6-astra | high | **critical 2D/3D/visual design work ONLY** — never for backend, refactors, reviews, or "hardest" non-visual tasks |

Nothing else is selectable: `luna`/`terra` and any other model slug are rejected with an error
listing the allowed tiers. `--effort E` overrides the tier's effort (default per tier above) and
must be `low`, `medium`, or `high` — anything else (`xhigh`, `max`, `ultra`, ...) is rejected. On
critical work the class is judged by the effective effort: only `high` is large (`sol-high --effort
low --critical` is refused; `sol --effort high --critical` is allowed). `astra` is refused without
`--critical` and only runs at `high`.
Each run logs `SELECT: vendor=codex tier=… model=… effort=… why=…`.

### Strengths — route by domain

- **2D/3D/visual design** (UI layout, canvas/SVG, three.js/WebGL, game graphics, motion/visual polish), strict order: 1) Codex `sol` (gpt-6.1-sol, effort by task). 2) Codex `astra` only when the work is too critical for sol (e.g. MC design, important final polish) — always with `--critical`. 3) Codex unavailable (not installed, quota out, refused/failed) → OpenCode `kimi` (kimi-k3). 4) Last fallback: Claude Opus 5.5. Kimi's 3D sense beats Opus.
- **Backend logic** (services, data pipelines, business logic, integrations, server-code debugging): Claude `opus` (Opus 5.5) beats Codex `sol` → prefer Claude Opus.

## Commands

If `agent-delegates` exits 127 (not installed globally), use
`node ~/.agent-delegates/pkg/bin/cli.js` instead (Windows:
`node %LOCALAPPDATA%\agent-delegates\pkg\bin\cli.js`). Never fall back to `npx` — it
re-downloads the package every run.

```sh
agent-delegates run codex sol BRIEF.md --cd /path/to/repo --name my-task
agent-delegates resume codex THREAD_ID FOLLOWUP.md --cd /path/to/repo [--tier T | --model M]
agent-delegates interrupt codex      # or interrupt my-task
agent-delegates close codex
```

`--ro` selects read-only sandbox (reviews); `--yolo` selects the full-access sandbox (see Full access below; incompatible with `--ro`). `--add-dir D` adds writable dirs.
Brief filename `-` reads stdin. Only the two allowlisted slugs (`gpt-6.1-sol` = tier
`sol`, `gpt-6-astra` = `astra`) work as the tier argument; any other raw slug is rejected.

Resume reuses the recorded model and effort; `--tier` wins over `--model` (both allowlist-checked);
a recorded model that is no longer allowed is remapped to the same size class (luna → `sol-low`,
terra → `sol`, old sol/astra → `sol-high`) with a logged line; a critical resume on a non-large
effective model is refused (pin `--tier sol-high` or `--effort high`), and no record pins `gpt-6.1-sol` with a warning (never Codex's own default). It pins model with `-c model=<slug>`,
sandbox with `-c sandbox_mode=` ALWAYS (also under `--full`; `--full` only drops `--ignore-user-config` and the clean-room flags),
and passes `--effort`; resume warns that Codex does not support `--add-dir`.

## Full access (`--yolo`) — frontier tiers only

`--yolo` gives the Codex worker FULL access (`sandbox_mode=danger-full-access`; never `--dangerously-bypass-approvals-and-sandbox`). It is allowed ONLY on a frontier
model/effort: `sol-high`, `sol --effort high`, `astra` (astra also needs `--critical` on EVERY launch, resume of a recorded astra thread included); `sol-low` and `sol` below effort high are refused. Anything else is refused by the CLI with an error naming the eligible
tiers (on `run`, `resume`, `handoff`, and `run auto`; in `run auto` an ineligible candidate is skipped with
`AUTO: <vendor> skipped — <reason>`).

Rules for the MAIN agent (the CLI cannot verify any of this; it is your duty):

- Before EVERY `--yolo` launch, ask the user: "Delegating <task> to <vendor> <model> (<tier>) with FULL
  access — approve?" One approval covers ONE launch. There is no standing grant.
- Call out risky actions in that question: prod hosts, live price pushes, DB writes, deletes, deploys.
  Repeat them in the brief.
- Every elevated launch prints `ELEVATED: vendor=… tier=… model=… effort=… mode=…` and records
  `elevated: true` in `meta.json`.

## Writing the brief

Use `brief-template.md` (same folder). Every brief needs Goal, Scope out,
and Acceptance criteria at minimum — a brief without acceptance criteria
produces a worker that guesses.

## Clean room (default)

Runs with `CODEX_HOME=~/.codex-fresh`: auth only, no user config, hooks, MCP,
plugins, global AGENTS.md or memories. Input tokens: ~13k (vs ~92k with the
user's full setup). Pass `--full` when the task needs user Codex skills or MCP;
repeat `--full` on `resume` (threads live in the home they were created in).
Still present: the skill catalog from `$CODEX_HOME/skills` (i.e.
`~/.codex-fresh/skills` in clean room; names only) and the repo's own
`AGENTS.md`. (Codex loads skills from `$CODEX_HOME/skills` — confirmed via
`codex --help` — never `~/.agents/skills`, which codex never reads.)

## Where the user sees it

One terminal window per vendor/name, opened by the first job and **reused**
by every later run/resume. The window shows: `BRIEF vendor model` header,
narrative, tool activity, final result. Closes on `close` or after 10 idle
minutes (`DELEGATE_IDLE_MIN`). Red only for worker failure.

The orchestrator drops a job file, spends no tokens watching, and gets
`exit` + `last.md` back. No display → tmux fallback; `DELEGATE_NO_WINDOW=1`
→ plain inline run.

## Verify

- Read `last.md`; grep `events.jsonl` only to debug.
- `OPEN QUESTIONS` non-empty → `resume`, don't respawn.
- Verify progress from **artifact state** (git status, file mtimes), not the
  narrative. Non-trivial diff → review as usual.

## Gotchas

| Symptom | Cause / fix |
|---------|-------------|
| `codex exec` hangs, no output | stdin left open; launcher feeds via file. Manual call: add `</dev/null`. |
| resume errors `unexpected argument '--color'` | `exec resume` accepts fewer flags; always pass the same `--cd` as the run. |
| worker says file "absent" on resume | forgot `--cd`; it resumed in the orchestrator's cwd. |
| `failed to load skill ...` on stderr | harmless; a broken skill in `$CODEX_HOME/skills`. |
| ~30 s + 90k input tokens before first edit | `--full` loaded user's skills. Clean-room default avoids it. |
| `tier/model '…' not allowed for codex` | Only `sol-low`/`sol`/`sol-high`/`astra` (or raw `gpt-6.1-sol`/`gpt-6-astra`). Pick a tier. |
| Codex cannot `git commit` | The sandbox mounts `.git` read-only. The orchestrator commits; brief the worker "do not commit". |
| Stream ends with `turn.failed`, exit 1 | Codex hit the 5-hour usage limit mid-run. The exit message includes the reset time. Resume the same thread after the reset window. |
| Need to continue on a *different* vendor (quota/reset too far out) | Don't hand-roll a new brief — `agent-delegates handoff <job-dir> <vendor> [tier] --cd DIR` builds a continuation brief from the failed job's brief/meta/last.md/events/git-state and fires it at the new vendor. |

Never use `--dangerously-bypass-approvals-and-sandbox`; `workspace-write` +
`--add-dir` covers worktrees. Full access only via the gated `--yolo` above.

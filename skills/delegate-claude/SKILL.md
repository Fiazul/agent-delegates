---
name: delegate-claude
description: Use when a main agent needs to delegate work to a Claude Code worker — user says "use claude", "claude worker", "delegate to claude", or wants Claude's strengths on a subtask. Supports sonnet/opus tiers (Sonnet 5.5, Opus 5.5). Default permission is acceptEdits; --yolo (full access) is allowed on opus only.
---

# Delegate to Claude Code

For any main agent that wants to delegate to Claude Code. Same
brief/acceptance/review rules as all other vendor workers.
The launcher prepends the standard worker preamble.

Critical work (`--critical`): only `opus` allowed.

## Tier ladder

| Tier | Claude model | Use for |
|------|--------------|---------|
| `sonnet` | claude-sonnet-5-5 | **default** simple / standard implementation |
| `opus` | claude-opus-5-5 | reviews, big / hard work, multi-step reasoning (and backend logic) |

`--effort E` selects reasoning effort. Nothing else is selectable: `haiku`, the old
`claude-sonnet-5`/`claude-opus-5` slugs, and any other raw slug are rejected with an error listing
the allowed tiers (only `claude-sonnet-5-5`/`claude-opus-5-5` pass as raw slugs). Each run logs
`SELECT: vendor=claude tier=… model=… effort=… why=…`. The size class comes from the tier only: `--effort`
never changes it (`sonnet --effort high` is still standard: no `--critical`, no `--yolo`).

### Strengths — route by domain

- **2D/3D/visual design** (UI layout, canvas/SVG, three.js/WebGL, game graphics, motion/visual polish): Codex `sol`/`astra`, OpenCode `kimi` (kimi-k3) — equal options, all beat Claude Opus here. Kimi's 3D sense is clearly better than Opus. Codex vs Kimi is unranked; pick by quota and availability. (`astra` only when the visual work is critical.)
- **Backend logic** (services, data pipelines, business logic, integrations, server-code debugging): Claude `opus` (Opus 5.5) beats Codex `sol` → prefer Claude Opus.

## Commands

If `agent-delegates` exits 127 (not installed globally), use
`node ~/.agent-delegates/pkg/bin/cli.js` instead (Windows:
`node %LOCALAPPDATA%\agent-delegates\pkg\bin\cli.js`). Never fall back to `npx` — it
re-downloads the package every run.

```sh
agent-delegates run claude sonnet BRIEF.md --cd /path/to/repo --name my-task
agent-delegates resume claude SESSION_ID FOLLOWUP.md --cd /path/to/repo [--tier T | --model M]
agent-delegates interrupt claude
agent-delegates close claude
```

Brief filename `-` reads stdin. `--add-dir D` adds directories.
Resume reuses the recorded model; `--tier` wins over `--model` (both allowlist-checked); a
recorded model that is no longer allowed is remapped to `claude-sonnet-5-5` with a logged line, and
no record pins `claude-sonnet-5-5` with a warning. Those flags are invalid on `run`.

## Writing the brief

Use `../delegate-codex/brief-template.md`. Every brief needs Goal, Scope out,
and Acceptance criteria at minimum — a brief without acceptance criteria
produces a worker that guesses.

## Permissions

Default is `--permission-mode acceptEdits`: edits auto-approved, shell
commands denied. `--yolo` enables `--dangerously-skip-permissions` for
briefs that run commands (gated: see below). Scope briefs carefully.

## Full access (`--yolo`) — frontier tiers only

`--yolo` gives the Claude worker FULL access (`--dangerously-skip-permissions`). It is allowed ONLY on a frontier
model/effort: `opus` only; `sonnet` is refused. Anything else is refused by the CLI with an error naming the eligible
tiers (on `run`, `resume`, `handoff`, and `run auto`; in `run auto` an ineligible candidate is skipped with
`AUTO: <vendor> skipped — <reason>`).

Rules for the MAIN agent (the CLI cannot verify any of this; it is your duty):

- Before EVERY `--yolo` launch, ask the user: "Delegating <task> to <vendor> <model> (<tier>) with FULL
  access — approve?" One approval covers ONE launch. There is no standing grant.
- Call out risky actions in that question: prod hosts, live price pushes, DB writes, deletes, deploys.
  Repeat them in the brief.
- Every elevated launch prints `ELEVATED: vendor=… tier=… model=… effort=… mode=…` and records
  `elevated: true` in `meta.json`.


## Where the user sees it

One terminal window per vendor/name, opened by the first job and **reused**
by every later run/resume. The window shows: `BRIEF claude model` header,
assistant text, tool names with short inputs, tool-result snippets, and the
final result. Closes on `close` or after 10 idle minutes
(`DELEGATE_IDLE_MIN`). Red only for worker failure.

No display → tmux fallback; `DELEGATE_NO_WINDOW=1` → plain inline run.

## Verify

- Read `last.md` first; grep `events.jsonl` only to debug.
- `OPEN QUESTIONS` non-empty → `resume` to preserve context.
- Verify from artifact state (git status, file mtimes), not the narrative.
- Non-trivial diff → review as usual.

## Orchestration

Each job records `brief.md`, `prompt.md`, `events.jsonl`, `last.md`,
`session_id`, `exit`, and `stderr.log`. The launcher prints `out=`, `exit=`,
`session_id=`, `usage=`, `open=`, and the final message.

Set `DELEGATE_OUT` to a scratch directory; `CODEX_WORKER_OUT` is a fallback.
Console logs: `~/.cache/delegates/<name>/console.log` (POSIX) or
`%LOCALAPPDATA%/delegates/<name>/console.log` (Windows).

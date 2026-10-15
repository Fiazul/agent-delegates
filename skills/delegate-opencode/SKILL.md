---
name: delegate-opencode
description: Use when delegating a task to an OpenCode worker — user says "opencode", "use opencode", or wants an OpenCode free, glm, or kimi model. Runs non-interactively via `opencode run --format json`.
---

# Delegate to OpenCode

For any orchestrator that wants to delegate to OpenCode.
Same brief/acceptance/review rules as all other vendor workers.
The launcher prepends the standard worker preamble.

Critical work (`--critical`): only `glm`/`kimi` (frontier). The `free` tier and any `-free` slug are
NEVER critical: refused even with `--allow-small`.

## Tier ladder

| Tier | OpenCode model | Class | Use for |
|------|----------------|-------|---------|
| `free` | opencode/mimo-v2.6-flash-free | small | **default**; use ONLY when the user names OpenCode or for simple tasks. Never critical, never `--yolo` |
| `glm` | opencode-go/glm-5.3 | large | frontier: hard / critical work (the critical tier for `run auto`/`handoff`) |
| `kimi` | opencode-go/kimi-k3 | large | frontier: hard / critical work, strong 2D/3D/visual design |

`glm` and `kimi` are frontier models. Raw `provider/model` slugs from `opencode models` also work.
Their class: any `*-free` slug is small; ONLY these four are large (explicit allowlist,
`OPENCODE_LARGE_MODELS` in `lib/models.js`): `opencode-go/glm-5.3`, `opencode-go/glm-5.2`,
`opencode-go/kimi-k3`, `opencode-go/kimi-k2.7-code`; every other slug is standard (never large: no
`--critical`, no `--yolo`, and `--allow-small` does not unlock critical on OpenCode).
**New frontier models must be added to that list by hand** (a name pattern like `glm-*` is deliberately not
used, so a lightweight or experimental variant can never be promoted silently). The class comes from the
tier/model only; `--effort` (`--variant`) never changes it. A resumed session with no recorded model is
unknown, hence refused for `--critical`/`--yolo` unless you pin `--tier glm|kimi`.

### Strengths — route by domain

- **2D/3D/visual design** (UI layout, canvas/SVG, three.js/WebGL, game graphics, motion/visual polish), strict order: 1) Codex `sol` (gpt-6.1-sol, effort by task). 2) Codex `astra` only when the work is too critical for sol (e.g. MC design, important final polish) — always with `--critical`. 3) Codex unavailable (not installed, quota out, refused/failed) → OpenCode `kimi` (kimi-k3). 4) Last fallback: Claude Opus 5.5. Kimi's 3D sense beats Opus.
- **Backend logic** (services, data pipelines, business logic, integrations, server-code debugging): Claude `opus` (Opus 5.5) beats Codex `sol` → prefer Claude Opus.

## Commands

If `agent-delegates` exits 127 (not installed globally), use
`node ~/.agent-delegates/pkg/bin/cli.js` instead (Windows:
`node %LOCALAPPDATA%\agent-delegates\pkg\bin\cli.js`). Never fall back to `npx` — it
re-downloads the package every run.

```sh
agent-delegates run opencode free BRIEF.md --cd /path/to/repo --name my-task
agent-delegates resume opencode SESSION_ID FOLLOWUP.md --cd /path/to/repo [--tier T | --model M]
agent-delegates interrupt opencode
agent-delegates close opencode
```

Brief filename `-` reads stdin.
Resume reuses the recorded model; `--tier` wins over `--model`, and no record
prints a warning before using the vendor default. OpenCode maps `--effort` to
`--variant` and warns that `--add-dir` is unsupported; both flags are invalid on `run`.

## Writing the brief

Use `../delegate-codex/brief-template.md`. Every brief needs Goal, Scope out,
and Acceptance criteria at minimum — a brief without acceptance criteria
produces a worker that guesses.

## Permissions

Without `--yolo`, headless OpenCode may deny permission requests.
`--yolo` enables `--auto` (auto-approve permissions that are not explicitly
denied). Scope briefs carefully when using `--yolo`.

## Full access (`--yolo`) — frontier tiers only

`--yolo` gives the OpenCode worker FULL access (`--auto`). It is allowed ONLY on a frontier
model/effort: `glm` and `kimi` (and the four allowlisted large raw slugs above); `free`/`-free`/standard/unknown slugs are refused. Anything else is refused by the CLI with an error naming the eligible
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
by every later run/resume. The window shows: `BRIEF opencode model` header,
text, tool activity, and the final result. Closes on `close` or after 10
idle minutes (`DELEGATE_IDLE_MIN`). Red only for worker failure.

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

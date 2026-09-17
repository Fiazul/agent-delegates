---
name: delegates
description: Use when the user types /delegates or asks how much quota is left on Claude, Codex, Antigravity, Grok, Cursor, or OpenCode, or before spawning any worker when Claude weekly usage may be high. Zero-cost status check; shows remaining quota and models for all six vendors.
---

# /delegates — Quota and status

## Before spawning any worker

1. Run `agent-delegates pick --json` and follow it — this is the one-line pre-spawn decision
   (route, and for `route:"external"` the exact vendor/tier/command to use). Add `--critical` for
   production/servers/live-data work. See README.md "pick: the one-line pre-spawn decision".
2. Then the rest of this routine as needed (status table, worker launchers, auto routing).

`agent-delegates install` asks which CLI is your main orchestrator and which delegates you want
(or `--main`/`--delegates` non-interactively) — see README.md "Install" for the two questions,
the resulting `routing.json` `priority`/`bins`, and the Cursor/Grok `agent`-collision prompt.

Run `agent-delegates status`, or `npx github:Fiazul/agent-delegates status`
when not globally installed. Print the output verbatim in a fenced block.
No commentary, no tiers, no routing text — the user reads the table and
decides.

Add `--probe-grok` only when asked: it spends a tiny paid call to refresh
Grok's balance status.

## What it shows

| Column | Source |
|--------|--------|
| **claude** | `~/.claude/rate_limits.json` (written by the statusline, installed by default with `install`; opt out with `--no-statusline`); weekly % and 5-hour % |
| **codex** | ChatGPT usage API via local auth; weekly %, 5-hour %, reset hours |
| **agy** | `agy -p /usage` (zero tokens); both quota groups: `gemini` and `claude/gpt` |
| **grok** | `~/.grok/.last_402` marker or `--probe-grok`; models from `grok models` |
| **cursor** | `cursor-agent status --format json` auth; models from `cursor-agent --list-models` |
| **opencode** | auth file presence; models from `opencode models` |

Credentials and email addresses are never displayed.

## Worker launchers

Workers use these skills — each with `run`, `resume`, `interrupt`, `close`:

| Skill | Vendors |
|-------|---------|
| `delegate-codex` | Codex (OpenAI) |
| `delegate-antigravity` | Antigravity / agy (Google) |
| `delegate-grok` | Grok Build (xAI) |
| `delegate-claude` | Claude Code (Anthropic) |
| `delegate-cursor` | Cursor Agent (`cursor-agent` CLI) |
| `delegate-opencode` | OpenCode |

Routing guidance lives in `extras/claude-routing-rule.md`.

## Auto routing and handoff

| Command | Semantics |
|---------|-----------|
| `agent-delegates run auto BRIEF.md [--priority v1,v2,...] [--max-hops N] --cd DIR` | Runs the brief on the first vendor with quota (default order agy,codex,grok,cursor,opencode,claude); on quota exhaustion, hands off to the next usable vendor (up to `--max-hops`, default 2); a non-quota failure never hops |
| `agent-delegates handoff JOB_DIR VENDOR [TIER] --cd DIR` | Builds a continuation brief from a finished job (original brief, failure reason, git status/diff-stat, last worker message) and starts a fresh job for `VENDOR` there |
| `agent-delegates route-check [--json] [--probe]` | Reports the routing-policy decision (`claude`/`external`/`unknown`) — pace-based, configurable via `~/.config/delegates/routing.json`; reads the cached vendor-status snapshot (`~/.cache/delegates/rows.json`) when under `rowsTtlMinutes` (default 10) old, otherwise probes vendors and refreshes it — `--probe` forces a fresh probe |
| `agent-delegates pick [--critical] [--json]` | The one-line pre-spawn decision: `route-check` plus the actual vendor/tier/command to run (or "stay on Claude") — see "Before spawning any worker" above |

See README.md "Auto routing and cross-vendor handoff" for the full hop rule and what the continuation brief contains, and "When does the orchestrator delegate? (routing policy)" for `route-check`/`pick`.

The `UserPromptSubmit` and `PreToolUse` hooks (installed by default) fire automatically — at the
start of the turn and again before an `Agent`/`Bash` tool call, to catch a quota crossing mid-turn
— injecting a reminder to run `agent-delegates pick --json` and follow it when the route is
`external`. Advisory only; disable with `--no-hook` at install time, or `mode: "fixed"` +
`threshold: 100` in `routing.json`.

## Critical work guard

Pass `--critical` on `run`/`run auto`/`handoff` for production/destructive-shaped work (or let a
`guard.paths` match in `routing.json` catch it) — either one refuses small/standard models (only
`sol`/`opus`/`best`-class tiers pass; `cursor`/`opencode` never qualify) and warns on full-bypass
permission modes. The `guard.keywords` heuristic is advisory only — it prints a `CRITICAL?` hint
but never refuses by itself. `resume` never refuses either way (the model was already fixed at
thread creation) — it only warns. `--allow-small` overrides the refusal. See README.md "Critical
work and permissions" for the full table and detection rules.

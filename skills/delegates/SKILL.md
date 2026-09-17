---
name: delegates
description: Zero-cost quota check for Claude, Codex, Antigravity, Grok, Cursor, and OpenCode. Use when the user types /delegates, asks how much quota is left, or before spawning any worker when Claude weekly usage may be high.
---

# /delegates — quota status

Run exactly one command:

```sh
agent-delegates status
```

If that exits 127 (not installed globally): `node ~/.agent-delegates/pkg/bin/cli.js status`
(Windows: `node %LOCALAPPDATA%\agent-delegates\pkg\bin\cli.js status`). Never fall back to
`npx` — it re-downloads the package every run.

Do not announce the command, summarize the table, or re-print it in your reply — the tool
output is already visible to the user. Reply with nothing beyond the tool call, unless
something needs action (a vendor is logged out, or a hop is recommended), in which case
add at most one line saying what and why.

Zero-token alternative: typing `! agent-delegates status` in the prompt runs it as a shell
command with no model turn at all.

## Before spawning any worker

Brief template: `../delegate-codex/brief-template.md` — Goal, Scope out, and
Acceptance criteria are mandatory.

Hard cap: **3 concurrent workers** (all vendors, subagents, and reviewers combined) unless the
user explicitly asks for more. At the cap, wait for one to finish before launching the next.

Run `agent-delegates pick --json` and follow it (add `--critical` for production/live-data
work) — see README.md "pick: the one-line pre-spawn decision".

## Worker launchers

`delegate-codex`, `delegate-antigravity`, `delegate-grok`, `delegate-claude`,
`delegate-cursor`, `delegate-opencode` — each with `run`/`resume`/`interrupt`/`close`.
Routing guidance: `extras/claude-routing-rule.md`. Auto routing/handoff, critical-work
guard, and column sources: README.md "Quota table", "Auto routing and cross-vendor
handoff", "Critical work and permissions".

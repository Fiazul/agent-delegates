---
name: delegates
description: Use when the user types /delegates or asks how much quota is left on Claude, Codex, Antigravity, Grok, Cursor, or OpenCode, or before spawning any worker when Claude weekly usage may be high. Zero-cost status check; shows remaining quota and models for all six vendors.
---

# /delegates — Quota and status

Run `agent-delegates status`, or `npx github:Fiazul/agent-delegates status`
when not globally installed. Print the output verbatim in a fenced block.
No commentary, no tiers, no routing text — the user reads the table and
decides.

Add `--probe-grok` only when asked: it spends a tiny paid call to refresh
Grok's balance status.

## What it shows

| Column | Source |
|--------|--------|
| **claude** | `~/.claude/rate_limits.json` (written by `install --statusline`); weekly % and 5-hour % |
| **codex** | ChatGPT usage API via local auth; weekly %, 5-hour %, reset hours |
| **agy** | `agy -p /usage` (zero tokens); both quota groups: `gemini` and `claude/gpt` |
| **grok** | `~/.grok/.last_402` marker or `--probe-grok`; models from `grok models` |
| **cursor** | `agent status --format json` auth; models from `agent --list-models` |
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
| `delegate-cursor` | Cursor Agent (`agent` CLI) |
| `delegate-opencode` | OpenCode |

Routing guidance lives in `extras/claude-routing-rule.md`.

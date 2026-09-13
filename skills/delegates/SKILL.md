---
name: delegates
description: Use when the user types /delegates or asks how much quota is left on Claude, Codex, Antigravity or Grok, or before spawning any worker when Claude weekly usage may be high.
---

# /delegates

Tokenless alternative for the user: `! ~/.claude/skills/delegates/delegates.sh` in the prompt, or
`delegates` in any shell (bashrc alias). Invoking `/delegates` costs one model turn to relay the table.

Run `~/.claude/skills/delegates/delegates.sh` (add `--probe-grok` only if asked to recheck
Grok; it costs one tiny call). Print the output verbatim in a fenced block. No commentary,
no tiers, no routing text — the user reads four lines and decides.

Each launcher opens the worker in its own terminal window. Launchers: `/delegate-codex`, `/delegate-antigravity`, `/delegate-grok`. Routing rule lives
in global CLAUDE.md. Claude line comes from `~/.claude/rate_limits.json` (statusline writes it).

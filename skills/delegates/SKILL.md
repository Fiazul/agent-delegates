---
name: delegates
description: Show remaining quota and models for Claude, Codex, Antigravity, and Grok.
---

# Delegates status

Run `agent-delegates status`, or `npx github:Fiazul/agent-delegates status`
when not globally installed. Print the table verbatim in a fenced block without
routing commentary. The `delegates` executable with no arguments also shows status.
Only add `--probe-grok` when asked: it spends a tiny paid call.
Claude reads the snapshot produced by install --statusline; Codex queries usage;
agy reports both quota groups; Grok uses the last-402 marker.
Never print authentication files, tokens, or email addresses.

Workers use delegate-codex, delegate-antigravity, delegate-grok, and delegate-claude.
All use run, resume, interrupt, and close.

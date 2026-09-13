## Cross-vendor routing (Codex / Antigravity / Grok)

- Before spawning workers, run `~/.claude/skills/delegates/delegates.sh` (skill `delegates` (`/delegates`)). Quote its Claude week % and the chosen vendor's line in the report whenever an external worker is fired.
- If Claude week ≥ 40% and I did not name Opus/Fable for the task, route non-trivial work to external workers first: Antigravity (`delegate-antigravity`, free) → Codex (`delegate-codex`, paid quota) → Grok (`delegate-grok`, only when not 402). Claude subagents stay for `opus5-reviewer` when asked, and as fallback when externals refuse/fail twice.
- Below 40%, Claude workers remain the default; externals when I ask ("summon codex", "use agy") or for a second-vendor opinion.
- External workers get the same brief discipline (constraints, acceptance, sole-executor preamble — the launchers prepend it), the same review gate, and the same artifact-state verification. Each external worker runs in its own terminal window (launcher does it); never ask the user to attach to tmux. Antigravity runs `--yolo` by default (authorised 2026-09-13); Codex stays sandboxed (`workspace-write`), never `--dangerously-bypass-approvals-and-sandbox`.
- Codex tiers: luna≈Haiku, terra≈Sonnet (default), sol≈Opus, astra≈Fable (allowed for Codex; hardest only). Antigravity: lite/flash(default)/pro + claude-sonnet/opus on Google quota.


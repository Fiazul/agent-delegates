---
name: delegate-codex
description: Use when delegating a task to a Codex (OpenAI) worker — user says "codex", "summon codex", "use sol/astra/terra/luna", wants a second-vendor opinion, or Claude weekly usage is high. Codex runs non-interactively via `codex exec`; hangs, wrong model slugs, sandbox git restrictions, and 5-hour usage limits are the usual failures.
---

# Delegate to Codex

Codex-side twin of a Claude subagent. Same orchestration rules: brief with
constraints + acceptance criteria, worker is sole executor, review the diff
afterwards. The launcher prepends the standard worker preamble.

## Tier ladder (orchestrator picks)

| Tier | Codex model | ~Claude | Use for |
|------|-------------|---------|---------|
| `luna` | gpt-5.6-luna | Haiku | trivial lookups, formulaic generation |
| `terra` | gpt-5.6-terra | Sonnet | **default** build / fix / test |
| `sol` | gpt-5.6-sol | Opus | hard tasks, reviews |
| `astra` | gpt-6-astra | Fable | hardest architecture / multi-system debugging |

`--effort low|medium|high|xhigh|max` (default medium). Raise effort before tier.

## Commands

Use `agent-delegates` when globally installed. Otherwise use
`npx github:Fiazul/agent-delegates` in every command.

```sh
agent-delegates run codex terra BRIEF.md --cd /path/to/repo --name my-task
agent-delegates resume codex THREAD_ID FOLLOWUP.md --cd /path/to/repo
agent-delegates interrupt codex      # or interrupt my-task
agent-delegates close codex
```

`--ro` selects read-only sandbox (reviews). `--add-dir D` adds writable dirs.
Brief filename `-` reads stdin. Raw model slugs (e.g. `gpt-5.6-sol`) work
as the tier argument.

## Clean room (default)

Runs with `CODEX_HOME=~/.codex-fresh`: auth only, no user config, hooks, MCP,
plugins, global AGENTS.md or memories. Input tokens: ~13k (vs ~92k with the
user's full setup). Pass `--full` when the task needs user Codex skills or MCP;
repeat `--full` on `resume` (threads live in the home they were created in).
Still present: the skill catalog from `~/.agents/skills` (names only) and the
repo's own `AGENTS.md`.

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
| `failed to load skill ...` on stderr | harmless; a broken skill in `~/.agents/skills`. |
| ~30 s + 90k input tokens before first edit | `--full` loaded user's skills. Clean-room default avoids it. |
| unknown model | slugs from `~/.codex/models_cache.json`. |
| Codex cannot `git commit` | The sandbox mounts `.git` read-only. The orchestrator commits; brief the worker "do not commit". |
| Stream ends with `turn.failed`, exit 1 | Codex hit the 5-hour usage limit mid-run. The exit message includes the reset time. Resume the same thread after the reset window. |

Never use `--dangerously-bypass-approvals-and-sandbox`; `workspace-write` +
`--add-dir` covers worktrees.

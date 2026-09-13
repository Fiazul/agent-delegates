---
name: delegate-codex
description: Use when delegating a task to a Codex (OpenAI) worker instead of a Claude subagent — user says "codex", "summon codex", "/delegate-codex", "use sol/astra/terra/luna", or wants a second-vendor opinion/implementation. Codex runs non-interactively via `codex exec`; hangs, wrong model slugs and lost follow-up context are the usual failures.
---

# Delegate to Codex

Codex-side twin of `sonnet5-worker` / `opus5-reviewer`. Same orchestration rules apply
(brief with constraints + acceptance criteria, worker is sole executor, review afterwards).
Only the launcher differs: a shell script instead of the Agent tool.

## Tier ladder (orchestrator picks, user shouldn't have to)

| Tier | Codex model | Claude equivalent | Use for |
|------|-------------|-------------------|---------|
| `luna` | gpt-5.6-luna | Haiku | trivial lookups, formulaic generation |
| `terra` | gpt-5.6-terra | Sonnet 5 | **default** build / fix / test |
| `sol` | gpt-5.6-sol | Opus 5 | hard tasks, reviews |
| `astra` | gpt-6-astra | Fable | hardest architecture / multi-system debugging |

Effort `--effort low|medium|high|xhigh|max` (default medium). Raise effort before raising tier.

## Launch (always `run_in_background: true`, like an Agent spawn)

```bash
# 1. brief to a file (scratchpad), same content you'd give a sonnet5-worker
# 2. launch
~/.claude/skills/delegate-codex/codex-worker.sh run terra BRIEF.md --name <task> --cd <repo>
#    --ro          read-only sandbox (reviews)
#    --effort high
#    --add-dir D   extra writable dir (worktrees)
# 3. follow-up / answer a worker question (keeps Codex's context, like SendMessage)
echo "answer..." | ~/.claude/skills/delegate-codex/codex-worker.sh resume <thread_id> - --cd <repo>
```

Set `CODEX_WORKER_OUT=<scratchpad>/codex` **in the same Bash call** as the launcher (env does not persist between calls); default is `/tmp/codex-workers`.
Each run leaves `<out>/<name>-<ts>/{brief.md,prompt.md,events.jsonl,last.md,thread_id,exit,stderr.log}`.
The script prints `out=`, `exit=`, `thread_id=`, token `usage=`, then the final message.
The script prepends the standard worker preamble (sole executor, no tree-rewriting git, no
secrets, fix categories not instances, fixed report sections DONE / ACCEPTANCE / VERIFICATION /
FILES TOUCHED / OPEN QUESTIONS) — don't repeat it in the brief.

## Clean room (default)

The launcher runs Codex with `CODEX_HOME=~/.codex-fresh`: auth only, no user config, hooks,
MCP servers, plugins, global AGENTS.md or memories. The worker knows nothing but the harness
defaults, the preamble and your brief (13k input tokens on a trivial prompt vs 92k with the
user's full setup). Pass `--full` only when the task needs the user's Codex skills or MCP
servers, and pass it again on `resume` (threads live in the home they were created in).
Still present in clean room: the skill *catalog* from `~/.agents/skills` (shared dir, names
only) and the repo's own `AGENTS.md` if one exists.

## Where the user sees it

One terminal window per vendor (titled `codex` / `agy` / `grok`, or `--name`), opened by the
first job and **reused** by every later run/resume; it closes on `close` or after 10 idle
minutes (`DELEGATE_IDLE_MIN`). The window is a file-driven job console: the orchestrator only
drops a job file, spends no tokens watching it, and gets exit code + `last.md` back.

```bash
<launcher> interrupt [name]   # kill the running job, drop queued ones, keep the window
<launcher> close [name]       # close the window (after the current job)
```

No display → tmux fallback; `DELEGATE_NO_WINDOW=1` → plain inline run.

## Verify like any worker

- Read `last.md`, not `events.jsonl` (events are large; grep them only to debug).
- `OPEN QUESTIONS` non-empty → answer via `resume`, don't respawn.
- Non-trivial result → spawn `opus5-reviewer` on the diff as usual. Codex output gets the same
  review gate as Claude output.
- Verify progress from artifact state (git status, file mtimes), not the narrative.

## Gotchas (each one cost a run)

| Symptom | Cause / fix |
|---------|-------------|
| `codex exec` hangs forever, no output | stdin left open; the script feeds the prompt via `-` from a file. Calling codex by hand: add `</dev/null`. |
| resume errors `unexpected argument '--color'` | `exec resume` accepts fewer flags than `exec`; no `-C` either — script `cd`s to `--cd`. Always pass the same `--cd` as the run. |
| worker says target file "absent" on resume | forgot `--cd`; it resumed in the orchestrator's cwd. |
| `failed to load skill .../canvas/SKILL.md: missing field description` on stderr | harmless; a broken user skill in `~/.agents/skills` (shared dir, loaded even in clean room). |
| ~30 s spent before first edit, 90k+ input tokens | only with `--full`: Codex reads the user's superpowers skills. Clean-room default avoids it. |
| unknown model | slugs come from `~/.codex/models_cache.json`; run `codex-worker.sh tiers`. |

Never use `--dangerously-bypass-approvals-and-sandbox`; `workspace-write` + `--add-dir` covers
worktrees. Never point Codex at the chat-API host project (see memory).

---
name: delegate-antigravity
description: Use when delegating a task to a Google Antigravity (agy) worker — free-tier Gemini/Claude models via the `agy` CLI — because Claude weekly usage is high, the user says "antigravity", "agy", "gemini worker", or wants a second-vendor implementation at zero cost. Headless `agy -p` auto-denies shell commands and flag order matters.
---

# Delegate to Antigravity (agy)

Free-tier twin of `sonnet5-worker`. Same orchestration rules (brief with constraints +
acceptance criteria; worker is sole executor; review the diff afterwards). Only the launcher
differs. Shared preamble: `~/.claude/skills/delegate-codex/worker-preamble.md`.

## Tier ladder

| Tier | agy model | ~Claude | Use for |
|------|-----------|---------|---------|
| `lite` | gemini-3.8-flash-low | Haiku | trivial; **may claim DONE without acting** |
| `flash` | gemini-3.8-flash-high | Sonnet | **default** build / fix / test |
| `pro` | gemini-3.1-pro-high | Opus | hard tasks, reviews |
| `sonnet` / `opus` | claude-sonnet-4-6 / claude-opus-4-6-thinking | same | Anthropic models on Google's quota |

Any raw slug from `agy models` also works as the tier.

## Launch (always `run_in_background: true`)

```bash
export CODEX_WORKER_OUT=<scratchpad>/workers   # same Bash call as the launcher
~/.claude/skills/delegate-antigravity/agy-worker.sh run flash BRIEF.md --name <task> --cd <repo>
#   --safe        edits-only mode (default is --yolo, see Permissions)
#   --add-dir D   extra writable dir
echo "answer" | ~/.claude/skills/delegate-antigravity/agy-worker.sh resume <conversation_id> - --cd <repo>
```

Run dir: `<out>/<name>-<ts>/{brief.md,prompt.md,events.jsonl,last.md,conversation_id,exit,stderr.log}`.
Script prints `conversation_id=`, `tool_steps=`, `usage=`, `exit=`, then the final message.

## Permissions

Headless mode cannot prompt, and `--mode accept-edits` auto-denies every shell command (tested:
the model runs `pwd` first and dies, even on edit-only briefs). So the launcher passes
`--dangerously-skip-permissions` by default — **authorised by the user on 2026-09-13**.
`--safe` opts back into accept-edits for a run you deliberately want edit-only.
Consequence: the sandbox is the working dir plus whatever the model decides; keep briefs
scoped, never point agy at the chat-API host project, and review the diff.

## Clean room

`--disable-slash-commands` is always passed (no skill/slash expansion). agy has no switch for
its user-global rule (`~/.gemini/GEMINI.md`, ~800 tokens) or its builtin skill catalog;
baseline is ~14k input tokens, mostly tool schemas. Acceptable; nothing to do.

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

## Verify

- `tool_steps=0` with a confident DONE = the model lied. Check artifact state (git status, file mtimes).
- Empty `last.md` → read the stderr the script prints; usually the permission denial above.
- Non-trivial diff → `opus5-reviewer` as usual.

## Gotchas

| Symptom | Fix |
|---------|-----|
| `-p took "--model" as its prompt` | `-p PROMPT` must be the **last** thing on the command line; script already orders it. |
| Run ends at exactly 5 min | default `--print-timeout 5m`; script passes `60m`. |
| Quota / 429 in stderr | weekly bucket empty (`agy -p /usage` shows both buckets, costs 0 tokens; `/delegates` prints them); reroute to Codex (`delegate-codex`) or Claude workers. |
| File landed in `~/.gemini/antigravity-cli/scratch/` | model treated "working dir" as its scratch; launcher now states the absolute dir in the prompt and passes `--add-dir`. Check `git status` in the repo, not the narrative. |
| Prompt too long for argv | keep briefs under ~100 KB; put bulk context in files the worker reads. |

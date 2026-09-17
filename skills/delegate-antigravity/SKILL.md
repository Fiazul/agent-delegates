---
name: delegate-antigravity
description: Use when delegating a task to Antigravity (agy) — free-tier Gemini/Claude via the agy CLI — because Claude weekly usage is high, user says "antigravity", "agy", "gemini worker", "use flash/pro", or wants a zero-cost second-vendor implementation. Headless agy auto-denies shell commands unless full-permission mode is used.
---

# Delegate to Antigravity (agy)

Free-tier twin of a Claude subagent. Same brief/acceptance/review rules.
The launcher prepends the standard worker preamble and adds an absolute
`WORKING DIRECTORY` header to the prompt.

Critical work (`--critical`): only `opus` allowed.

## Tier ladder

| Tier | agy model | ~Claude | Use for |
|------|-----------|---------|---------|
| `lite` | gemini-3.8-flash-low | Haiku | trivial; **may claim DONE without acting** |
| `flash` | gemini-3.8-flash-high | Sonnet | **default** build / fix / test |
| `pro` | gemini-3.1-pro-high | Opus | hard tasks, reviews |
| `sonnet` | claude-sonnet-4-6 | — | Anthropic model on Google quota |
| `opus` | claude-opus-4-6-thinking | — | Anthropic model on Google quota |

Any raw slug from `agy models` also works as the tier.

## Commands

If `agent-delegates` exits 127 (not installed globally), use
`node ~/.agent-delegates/pkg/bin/cli.js` instead (Windows:
`node %LOCALAPPDATA%\agent-delegates\pkg\bin\cli.js`). Never fall back to `npx` — it
re-downloads the package every run.

```sh
agent-delegates run agy flash BRIEF.md --cd /path/to/repo --name my-task
agent-delegates resume agy CONVERSATION_ID FOLLOWUP.md --cd /path/to/repo
agent-delegates interrupt agy
agent-delegates close agy
```

`--safe` selects accept-edits mode. `--add-dir D` adds workspace dirs.
Brief filename `-` reads stdin. Vendor alias `antigravity` is accepted.

## Permissions

Headless mode cannot prompt. `--mode accept-edits` auto-denies every shell
command (the model runs `pwd` first and dies). The launcher passes
`--dangerously-skip-permissions` by default. `--safe` opts back into
accept-edits for deliberately edit-only runs. Consequence: no sandbox beyond
the working dir. Keep briefs scoped and review the diff.

## Where the user sees it

One terminal window per vendor/name, opened by the first job and **reused**
by every later run/resume. The window shows: `BRIEF antigravity model`
header, narrative, tool activity, final result. Closes on `close` or after
10 idle minutes (`DELEGATE_IDLE_MIN`). Red only for worker failure.

No display → tmux fallback; `DELEGATE_NO_WINDOW=1` → plain inline run.

## Verify

- `tool_steps=0` with a confident DONE = the model lied. Check artifact
  state (git status, file mtimes).
- Empty `last.md` → read stderr; usually the permission denial above.
- Non-trivial diff → review as usual.

## Gotchas

| Symptom | Cause / fix |
|---------|-------------|
| `-p` took `--model` as its prompt | `-p PROMPT` must be last on the CLI; the launcher handles ordering. |
| Run ends at exactly 5 min | default `--print-timeout 5m`; launcher passes `60m`. |
| Quota / 429 in stderr | weekly bucket empty; `agent-delegates status` shows both buckets. Reroute to Codex or Claude. |
| File landed in `~/.gemini/.../scratch/` | model treated "working dir" as its scratch; launcher states the absolute dir in the prompt. Check `git status`, not the narrative. |
| Prompt too long for argv | keep briefs under ~100 KB; put bulk context in files the worker reads. |
| Gemini flash burned ~75% of weekly bucket in a dozen runs | 250k input tokens per run is normal for flash. The `claude/gpt` bucket is separate. `agent-delegates status` shows both. Budget accordingly. |
| Quota exhausted at 0%: stream ends `{"event":"result","result":{"status":"ERROR","response":"","error":"...RESOURCE_EXHAUSTED (code 429)...Resets in 144h14m57s."}}`, preceded by `step_update` events with `step_type:"error_message"` | `lib/failure.js` `classifyFailure()` now catches this (exit 1, `last.md` = `WORKER FAILED: ...`, console prints `ANTIGRAVITY EXHAUSTED — reroute to ...`) — no longer a silent exit 0. |

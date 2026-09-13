# agent-delegates

Delegate work from Claude Code to **Codex** (OpenAI), **Antigravity** (Google `agy`) and
**Grok Build** (xAI) the way you delegate to Claude subagents — brief in, report out — while
each external worker runs visibly in **one reusable terminal window per vendor**, and the
orchestrator spends no tokens watching it.

```
claude   wk 9% left · 5h 72% left        fable-5.1 opus-5 sonnet-5 haiku-4.5
codex    wk 84% (reset 146h) · 5h 83%    gpt-6-astra gpt-5.6-sol gpt-5.6-terra gpt-5.6-luna …
agy      gemini wk 90% · claude/gpt 100% gemini-3.8-flash{h/m/l} gemini-3.1-pro{h/l} claude-opus-4-6-thinking …
grok     exhausted (402 on 2026-09-13)   grok-4.5 grok-4.6
```

## Install (one command)

```bash
git clone https://github.com/Fiazul/agent-delegates.git ~/.agent-delegates && ~/.agent-delegates/install.sh --statusline
```

Symlinks the four skills into `~/.claude/skills` (Claude Code) and `~/.agents/skills`
(the cross-runtime dir Codex, Gemini CLI and Copilot read), adds a `delegates` shell alias,
and — with `--statusline` — makes Claude Code persist its own rate limits so the `claude` row
has data. `git pull` updates everything; `install.sh --uninstall` removes the links.

Requires whichever CLIs you use on PATH (`codex`, `agy`, `grok`), `jq`, `python3`,
and a desktop terminal (gnome-terminal / x-terminal-emulator; falls back to tmux).

## Skills

| Skill | What it does |
|---|---|
| `/delegates` | quota **left** + models per vendor, one line each, zero model tokens (`delegates.sh` also runs standalone) |
| `/delegate-codex` | `codex exec` worker; tiers `luna`≈Haiku · `terra`≈Sonnet · `sol`≈Opus · `astra`≈top; clean-room `CODEX_HOME` by default |
| `/delegate-antigravity` | `agy -p` worker; tiers `lite` · `flash` · `pro` · `sonnet` · `opus` (Claude 4.6 on Google quota) |
| `/delegate-grok` | `grok -p` worker; tiers `fast` · `best` |

Every launcher has the same four verbs:

```bash
<vendor>-worker.sh run <tier> BRIEF.md --cd <repo> [--name N]   # opens/reuses the vendor window
<vendor>-worker.sh resume <id> FOLLOWUP.md --cd <repo>          # same window, same thread
<vendor>-worker.sh interrupt [name]                             # kill the running job, keep window
<vendor>-worker.sh close [name]                                 # close the window
```

The window shows the exact brief, the vendor + model, the worker's own narrative, plain-English
tool lines (`reading x.py`, `$ pytest`, `editing y.py`), and the final report. Red means one
thing only: the worker failed. Everything is also logged to `~/.cache/delegates/<vendor>/console.log`.

## Orchestrator rule (optional)

`extras/claude-routing-rule.md` is the CLAUDE.md snippet that routes non-trivial work to the
external vendors when Claude's weekly limit is past 40 %. Paste it into your global CLAUDE.md.

## Notes

- Codex runs sandboxed (`workspace-write`, or `read-only` with `--ro`); never `--dangerously-bypass`.
- Antigravity headless mode cannot prompt, so the launcher passes `--dangerously-skip-permissions`
  (`--safe` = edits only, which in practice fails on the first `pwd`). Scope briefs accordingly.
- Grok returns HTTP 402 when the weekly balance is gone; the launcher reports it as a failure.

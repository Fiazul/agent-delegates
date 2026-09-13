# TODO (state as of 2026-09-13 13:10, pushed unreviewed at the user's request)

Branch `node-cli` = master now. Node port done by a Codex `sol` worker, docs by an Antigravity Opus worker;
Linux smoke passed (agy run/resume/close, claude haiku run). **No review pass completed** — every vendor
ran out of quota mid-review. Open items, in priority order:

1. **Review the Node port** against `docs`-less brief items: safety (Codex never gets
   `--dangerously-bypass-approvals-and-sandbox`; `install --statusline` must chain, never clobber, an
   existing statusline command), queue handshake races, interrupt kills the whole process tree.
2. **Bug: agy quota/stderr errors return exit 0.** Antigravity prints `error: Individual quota reached…`
   on stderr, not in the stream-json; `lib/runner.js` only flags `type: error` events. Treat a non-empty
   stderr `error:` line + empty result as failure (exit 1), like Grok 402.
3. **Codex smoke of the Node CLI not run** (Codex 5h window was exhausted). Run:
   `DELEGATE_OUT=/tmp/x node bin/cli.js run codex luna brief.md --cd /tmp/x --effort low`, then `resume`, then `close`.
4. **macOS / Windows paths untested** (Terminal.app via osascript; `wt.exe` / `cmd /k`; junction→copy fallback).
5. Renderer: confirm claude stream-json tool_use/tool_result rendering on a real run with tools.
6. Quota lesson to keep in docs: Antigravity's Claude/GPT weekly bucket is ~2 Opus-sized jobs; Gemini flash
   uses ~250k input tokens per job.

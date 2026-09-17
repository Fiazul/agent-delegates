# TODO (state as of 2026-09-13 13:10, pushed unreviewed at the user's request)

Branch `node-cli` = master now. Node port done by a Codex `sol` worker, docs by an Antigravity Opus worker;
Linux smoke passed (agy run/resume/close, claude haiku run). **No review pass completed** — every vendor
ran out of quota mid-review. Open items, in priority order:

1. **Review the Node port** against `docs`-less brief items: safety (Codex never gets
   `--dangerously-bypass-approvals-and-sandbox`; `install --statusline` must chain, never clobber, an
   existing statusline command), queue handshake races, interrupt kills the whole process tree.
2. ~~**Bug: agy quota/stderr errors return exit 0.**~~ **DONE (2026-09-17).** Added `lib/failure.js`
   `classifyFailure(vendor, ctx)` — single shared classifier, audited across all six vendors
   (codex `turn.failed`/`error`, agy `result.status===ERROR`/`step_type:error_message`, claude/cursor
   `result.is_error`/error subtypes/no-result-event-on-nonzero-exit, opencode `error.data.message`/429,
   grok 402, plus cross-vendor stderr `error:` and bare-nonzero-exit guards). `extractResult()`/`invoke()`
   in `lib/runner.js` call it as the single place of truth: on failure, exit file = 1, `last.md` =
   `WORKER FAILED: <reason>` (+ reset hint when parseable), console prints `<VENDOR> EXHAUSTED — reroute
   to <others>` when exhausted (grok keeps its `.last_402` marker; other vendors don't have an
   equivalent marker mechanism yet). Tests: `test/failure.test.js` (fixture-driven, one
   exhausted/failed fixture per vendor; `agy-quota-exhausted.jsonl` is a real 0%-quota capture, the rest
   are synthetic from verified vendor doc shapes — see `test/fixtures/README.md` and the inline
   comments in `lib/failure.js` for what's verified vs assumed). **This is the failover hook**: any orchestrator wiring auto-reroute-on-exhaustion should
   watch `result.exhausted` / the `<VENDOR> EXHAUSTED` console line rather than re-deriving vendor
   error shapes. `last.md` on failure is always the `WORKER FAILED: <reason>` banner followed by
   the preserved worker body (whatever text/output the worker produced before failing, if any) —
   never a truncation of real progress. Mid-stream error events (codex `error`, opencode
   retryable `APIError`, grok `error`) only count as a failure when no terminal success signal
   follows them later in the same stream (codex `turn.completed`/`agent_message`, opencode
   `text`/`step_finish reason:'stop'`, grok a later non-empty result) — `turn.failed` is the one
   codex signal that stays unconditionally fatal regardless of what precedes or follows it.
3. **Codex smoke of the Node CLI not run** (Codex 5h window was exhausted). Run:
   `DELEGATE_OUT=/tmp/x node bin/cli.js run codex luna brief.md --cd /tmp/x --effort low`, then `resume`, then `close`.
4. **macOS / Windows paths untested** (Terminal.app via osascript; `wt.exe` / `cmd /k`; junction→copy fallback).
5. Renderer: confirm claude stream-json tool_use/tool_result rendering on a real run with tools.
6. Quota lesson to keep in docs: Antigravity's Claude/GPT weekly bucket is ~2 Opus-sized jobs; Gemini flash
   uses ~250k input tokens per job.
7. **`run auto` / `handoff` live smoke not yet run** (2026-09-17, brief W2). `lib/route.js`
   `pickVendor`/`runAuto` are unit-tested against literal `lib/status.js` row strings and a fake
   `invoke`/`handoff` (no live vendor calls made — would spend quota). Never exercised against a
   real exhausted job or real `agent-delegates status` output. Before relying on it: run
   `agent-delegates run auto BRIEF.md --cd DIR` once against a vendor near/at exhaustion and confirm
   it actually hands off (prints `AUTO: <vendor> exhausted → handing off to <next>`, second job
   directory has a continuation brief built by `lib/handoff.js`), and once against a non-quota
   failure (bad brief) to confirm it does NOT hop.
8. **`DEFAULT_TIER` duplicated** in `lib/handoff.js` and `lib/route.js` — move both copies to a
   single source of truth in `lib/models.js` (it already owns `TIER_MAPS`/`resolveModel`).
9. **`run --cd X auto brief` positional quirk**: `--cd` before the `auto` subcommand vs after
   the brief file may parse differently depending on how `bin/cli.js` splits flags from
   positionals for the `run` command — verify/document the accepted flag order for `run auto`.
10. **Live smoke of a real hop still pending** (see item 7) — this is the same gap, tracked here
    too since it blocks trusting `run auto` in production use.
11. **`DELEGATE_WORKER=1` hard guard** planned: a worker launched by `agent-delegates` should not
    itself be able to shell out to the `agent-delegates` CLI (recursive delegation) — needs an
    env-var guard checked at CLI entry.
12. **Token accounting command (`tokens`) planned** — surface per-job token usage (already
    captured in `usage=` per invoke) as a rollup command across jobs/vendors.
13. **Skill slimming + `--quiet` JSON output planned** — trim the skill docs and add a
    machine-readable `--quiet`/JSON mode to `status`/`run` for scripting (e.g. `run auto` calling
    itself, or an outer orchestrator polling status without parsing the table).

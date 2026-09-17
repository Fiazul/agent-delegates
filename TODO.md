# TODO

**Status 2026-09-18.** Items 1–3, 5, 6 closed: Opus reviewed the Node port twice, findings fixed
(commits 1ec95da, 323890f, edf2758; 706 tests); codex smoke, renderer, agy/grok quota handling all
verified live. User tested from Cursor and Codex as orchestrators (workers on codex, claude, cursor,
opencode passed) and on Windows.

Still open:
- macOS paths untested (Terminal.app via osascript).
- agy / opencode as the *orchestrator*: not tested, and not a supported `install --main` target yet
  (only claude|codex|cursor|all; their skill dirs are unknown). Feature gap, not a test gap.
- A worker terminal failing is fine as long as the orchestrator sees it (exit file + last.md banner);
  not a bug.

The list below is history of what was checked and why. New items go in a fresh section at the top.

---

# History (state as of 2026-09-13 13:10, pushed unreviewed at the user's request)

Branch `node-cli` = master now. Node port done by a Codex `sol` worker, docs by an Antigravity Opus worker;
Linux smoke passed (agy run/resume/close, claude haiku run). **No review pass completed** — every vendor
ran out of quota mid-review. Open items, in priority order:

1. ~~**Review the Node port**~~ **DONE (2026-09-17).** Opus review done; blocker+highs fixed on
   branch `review-fixes`, rest deferred below.
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
8. ~~**`DEFAULT_TIER` duplicated** in `lib/handoff.js` and `lib/route.js`.~~ **DONE
   (2026-09-17).** Moved to a single `DEFAULT_TIER` export in `lib/models.js` (alongside
   `TIER_MAPS`/`CRITICAL_TIER`/`resolveModel`); both modules import it instead of redefining it.
9. ~~**`run --cd X auto brief` positional quirk**.~~ **DONE (2026-09-17).** `bin/cli.js` now
   accepts `auto` anywhere in the `run` positionals — `run --cd X auto brief.md`,
   `run auto brief.md --cd X`, and `run auto --cd X brief.md` all parse the same way.
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
14. ~~**Dynamic (pace-based) routing policy shipped.**~~ **DONE (2026-09-17, brief W3).** Added
    `lib/policy.js` (`loadConfig`/`decide`, pure, unit-tested) replacing the fixed-40%-in-a-
    private-hook rule: `mode: "pace"` compares weekly usage% against % of the week elapsed (+
    slack), with a 5-hour cap and a hard cap as escape hatches, falling back to `mode: "fixed"`
    when `resets_at` is unavailable; config at `~/.config/delegates/routing.json` /
    `%APPDATA%/delegates/routing.json`. `route-check [--json] [--self claude]` reports the
    decision without doing work. `extras/delegate-nudge.js` is a shipped `UserPromptSubmit` hook
    (installed by default via `lib/install.js` `installHook`/`uninstallHook`, opt out with
    `--no-hook`; `--no-statusline` opts out of the statusline, also now default-on) that injects
    a routing reminder into context only when the policy says `external`. `lib/route.js`
    `runAuto` now consults the same policy before picking a vendor (`respectPolicy` option,
    default true) and keeps `claude` on top of the try-order when the policy says stay. Docs:
    README "When does the orchestrator delegate? (routing policy)", `skills/delegates/SKILL.md`,
    `extras/claude-routing-rule.md` updated off the fixed-40% wording. Only the orchestrator
    reads any of this — workers never see it, unchanged.
15. **Codex-as-orchestrator policy (`--self codex`) pending** — `route-check --self` currently
    only supports `claude` (reports "unsupported, reports claude policy" for anything else); a
    Codex-orchestrated setup needs its own quota snapshot shape and probably its own
    `mode`/threshold defaults before `--self codex` can report anything real.

## Review 2026-09-17 — deferred

Findings from the same review pass as item 1 above, deferred rather than fixed on
`review-fixes` (blocker + highs were fixed; these are lower-priority or design decisions):

- R11 `lib/guard.js:20-26` (`DEFAULT_GUARD.paths = []`) — guard.paths is empty out of the box, so
  the hard-critical path check is inert on a stock install; only `--critical` or a user-configured
  `guard.paths` entry actually triggers it. This is a design decision (ship safe defaults, let the
  operator opt a real prod path in), not a bug — documented here so it isn't rediscovered as a
  surprise later.
- R13/F14 `lib/console.js` — stale-pid-after-reboot (a `.exit`/lock file referencing a pid that no
  longer exists post-reboot) and inline-vs-window consoles sharing the same job queue directory.
  Out of scope for this pass (console.js was being edited concurrently by another worker); check
  `lib/console.js` and `test/console.test.js` directly for current state.
- R15 `extras/statusline.js` — needs a downstream self-reference guard (statusline invoking
  something that could recurse back into itself) and a 2s timeout so a hung downstream command
  can't block the prompt render.
- Row-text coupling between `lib/status.js` (produces row strings) and `lib/route.js` (regexes
  that parse them, `isCodexUsable`/`isAgyUsable`/etc.) — add a test that feeds real row strings
  (captured from an actual `agent-delegates status` run) through `pickVendor` to catch drift if
  either side's wording changes without the other.
- Grok `--output-format json` may be pretty-printed (multi-line) rather than one-JSON-object-
  per-line — the per-line event renderer would show nothing until the whole process completes.
  Needs one real `grok` run to confirm the actual shape before deciding whether the renderer needs
  a buffering fallback.
- macOS/Windows paths untested (same as item 4 above, keep tracking there).
- m4 (Opus review, 2026-09-18) `lib/console.js` `acquireSpawnLock`/`releaseSpawnLock` — the
  `spawn.lock` file's mtime is never refreshed while a caller actually holds it (only checked
  once, at acquire time, against `SPAWN_LOCK_STALE_MS`); a legitimately slow `spawnWindow()` (a
  terminal emulator that's slow to launch) held past that window looks "stale" to a second
  concurrent caller, which then clears and re-acquires it out from under the first — a TOCTOU on
  the stale-clear itself (clear + re-create isn't atomic against a second racer doing the same
  check at the same moment). Deferred: needs either a heartbeat-refresh on the lock (like `pid`'s
  heartbeat) or an atomic take-over primitive; out of scope for this review-fixes pass.
- m10 (Opus review, 2026-09-18) `lib/console.js` heartbeat vs. suspend/resume — the `pid` file's
  heartbeat `setInterval` (10s) assumes the host stays running; a suspended (not crashed) host
  resuming after `HEARTBEAT_STALE_MS` (60s) of real wall-clock sleep looks dead to `alive()`
  even though the console process itself is still perfectly live, racing a second console into
  believing it can take over the same window. Deferred: needs either a wall-clock-vs-monotonic
  suspend detection or a longer/adaptive staleness window; out of scope for this review-fixes
  pass.
- M4 live-state gap: resume-with-model (`resolveResumeModel`/`buildJob`'s `-c model=...` /
  vendor-specific `--model`/`-m` on resume) has only been live-verified for codex (`codex exec
  resume --help`, confirmed no `-m`/`--add-dir`, has generic `-c`) and opencode (`opencode run
  --help`, confirmed `--variant`, `-m`, `-s/--session`) as part of this review-fixes pass. agy,
  grok, and cursor's resume-model flag behavior is still unverified against their real `--help`
  output/live runs — pending. claude verified live 2026-09-18: haiku run → resume pinned haiku, meta.model recorded.
- m4 (deferred): spawn lock never refreshed while held; stale-clear path can unlink a fresh lock
  after a crash (lib/console.js acquireSpawnLock). Narrow, post-crash only.
- Codex skill-link target fixed 2026-09-18: `install --main codex` used to link into
  `~/.agents/skills`, which the codex binary never reads (`codex --help`: skills load from
  `$CODEX_HOME/skills`, default `~/.codex/skills`). Now honors `CODEX_HOME` via `skillDirFor()`
  in lib/install.js. `--uninstall` still sweeps the old `~/.agents/skills` location (in addition
  to the corrected dirs) so pre-fix installs get fully cleaned up. Cursor's `~/.cursor/skills`
  and Claude's `~/.claude/skills` were verified correct as-is (strings on cursor-agent's bundled
  index.js confirm `.cursor/skills`).

## Codex resume model drift (fixed 2026-09-18, residual note)
- Before the fix, `resume` passed no model to any vendor; Codex fell back to `gpt-6-astra`, so
  resumed luna/terra threads ran on the top tier. Now `resolveResumeModel()` in `lib/runner.js`
  reuses the recorded model (or `--tier`/`--model`) and Codex gets `-c model=<slug>`.
- Residual: Codex prints an `item.completed` `type:"error"` "This session was recorded with model X
  but is resuming with Y" whenever a thread's last model differs. Informational, exit 0, not
  classified as failure. Threads that drifted before the fix will show it once per resume
  (reversed: recorded astra, resuming luna). New threads don't. Nothing to patch unless we want
  to surface it as a one-line console note instead of the raw error item.

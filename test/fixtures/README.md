# test/fixtures — provenance

Real captures are exact vendor output. Everything else is synthetic, hand-shaped from a
verified doc/schema source (cited below) because no real capture was available at write time
(codex/claude/cursor/opencode/grok success runs cost quota; see CLAUDE.md live-state rule).

| Fixture | Provenance |
|---|---|
| `agy.jsonl` | Synthetic — minimal success stream shaped like `agy-quota-exhausted.jsonl`'s non-error events. |
| `agy-quota-exhausted.jsonl` | **Real capture** — agy at 0% quota, 2026-09-17. |
| `claude.jsonl` | Synthetic — success stream shaped from Claude Code `stream-json` docs. |
| `claude-error.jsonl` | Synthetic — shaped from verified `result.subtype`/`is_error` schema (code.claude.com/docs/en/errors). |
| `codex.jsonl` | Synthetic — success stream shaped from `codex exec --json` docs. |
| `codex-turn-failed.jsonl` | Synthetic — shaped from verified `turn.failed` schema (github.com/openai/codex issue #41216, takopi cheatsheet). |
| `codex-transient-error-then-success.jsonl` | Synthetic — a mid-stream `type:'error'` (transient/retried) followed by a normal `agent_message` + `turn.completed`, per the takopi cheatsheet's documented transient-reconnect behavior. |
| `codex-turn-failed-with-partial-text.jsonl` | Synthetic — an `agent_message` with real progress text, then `turn.failed`; used to prove the streamed body is kept under the `WORKER FAILED` banner when codex crashed before writing its own `-o` file. |
| `cursor.jsonl` | Synthetic — success stream shaped from cursor.com/docs/cli/reference/output-format. |
| `cursor-error.jsonl` | Synthetic — no `result` event + non-zero exit, matching the documented cursor-agent behavior of exiting 1 with no result on auth/rate-limit failure (github.com/tiann/hapi issue #818). |
| `opencode.jsonl` | Synthetic — success stream shaped from the takopi OpenCode cheatsheet. |
| `opencode-error.jsonl` | Synthetic — shaped from verified `error.data.message`/`statusCode` schema (takopi cheatsheet). |
| `opencode-transient-error-then-success.jsonl` | Synthetic — a retryable `APIError` (`isRetryable:true`) followed by `text` + `step_finish reason:'stop'`. |
| `opencode-multi-text.jsonl` | Synthetic — two distinct `text` parts (different `part.id`) separated by a `step_finish reason:'tool-calls'`, proving `extractResult` accumulates both instead of the later part overwriting the earlier one (R9). |
| `grok.jsonl` | Synthetic — minimal success stream (no public grok CLI JSON schema doc found; shaped to match the `result`/`response`/`text` field-guessing already used by `extractResult`). |
| `grok-402.jsonl` | Synthetic — shaped from the existing `lib/status.js` 402-substring convention. |
| `grok-success-mentions-402.jsonl` | Synthetic — a successful result whose own text happens to mention "402", to prove the classifier doesn't false-positive on that (F5). |

See `lib/failure.js` inline comments for the same verified-vs-assumed notes at the point each
signal is checked.

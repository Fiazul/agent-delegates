'use strict';

// Shared vendor-failure classifier. Single place of truth for "did this worker actually
// fail" — extractResult()/invoke() in lib/runner.js both call this instead of each vendor
// branch guessing its own failure shape. See CLAUDE.md defect category: a worker fails in a
// vendor-specific way (quota, rate limit, auth expiry, max turns, turn.failed, stderr-only
// error) and the launcher must never report exit 0 / an empty last.md for that.

const QUOTA_RE = /RESOURCE_EXHAUSTED|quota|rate.?limit|\b429\b|\b402\b|usage limit|spend limit|session limit|weekly limit|credit balance/i;
const AUTH_RE = /login expired|invalid authentication|oauth token|\b401\b|logged out|run \/login/i;
const RESET_RE = /resets?\s+in\s+([0-9a-zA-Z:]+)/i;
// Grok 402 needs actual error context, not a bare "402" substring anywhere in the stream —
// a successful answer that happens to mention "402" (e.g. discussing the HTTP status code)
// must not be treated as quota exhaustion (F5).
const GROK_402_RE = /status\s*402|http\s*402|\(402\)|"402"|code\s*402/i;
const MAX_REASON_LEN = 300;

function isQuotaText(text) {
  return QUOTA_RE.test(String(text || ''));
}

function isAuthText(text) {
  return AUTH_RE.test(String(text || ''));
}

function parseResetHint(text) {
  const match = RESET_RE.exec(String(text || ''));
  return match ? match[1] : null;
}

function truncate(text, max = MAX_REASON_LEN) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Only the single matching line, truncated — never the whole stderr blob (F3).
function firstMatchingLine(text, re) {
  const line = String(text || '').split(/\r?\n/).find(l => re.test(l));
  return line ? truncate(line.trim()) : null;
}

function firstStderrErrorLine(stderr) {
  return firstMatchingLine(stderr, /^\s*(error|Error):/);
}

/**
 * classifyFailure(vendor, ctx) -> { failed, reason, exhausted, resetHint }
 *
 * ctx: { events (parsed array), raw (raw events.jsonl text), stderr, exitCode, text (already
 * extracted result text, used for the "exit/error with nothing to show" guard) }
 *
 * Per-vendor shapes verified against real docs/output where noted; synthetic/assumed shapes
 * are called out in test/fixtures/README.md and in the worker report — this function does not
 * itself distinguish verified vs assumed, that lives in the brief report.
 *
 * Category rule for mid-stream retryable errors (codex/opencode/grok): an error event partway
 * through a stream is only fatal if no terminal success signal follows it. A vendor CLI that
 * retries transparently and then completes (codex: turn.completed/agent_message after a
 * transient `error`; opencode: a later `text`/step_finish reason:'stop' after an APIError;
 * grok: a later non-empty result/response/text after an `error`) must not be reported as
 * failed. `turn.failed` (codex) is the one signal that stays unconditionally fatal — it is
 * codex's own terminal failure event, not a mid-stream retry notice.
 */
function classifyFailure(vendor, ctx = {}) {
  const { events = [], raw = '', stderr = '', exitCode = 0, text = '', timeoutMin } = ctx;
  let failed = false;
  let reason = '';
  let exhausted = false;
  let resetHint = null;

  function flag(r, opts = {}) {
    failed = true;
    if (r) reason = truncate(r);
    if (opts.exhausted) exhausted = true;
    if (opts.resetHint && !resetHint) resetHint = opts.resetHint;
  }

  // Cross-vendor: the job runner (lib/console.js) killed a hung child after its timeout and
  // reports exit 124 regardless of vendor — this is never a vendor-specific quota/auth/parse
  // failure, so it short-circuits every vendor branch below rather than risking a vendor parser
  // misreading the (likely truncated/empty) event stream as something else.
  if (Number(exitCode) === 124) {
    const minutes = timeoutMin != null ? timeoutMin : 'N';
    return { failed: true, reason: `timed out after ${minutes} min (DELEGATE_JOB_TIMEOUT_MIN / --timeout)`, exhausted: false, resetHint: null };
  }

  if (vendor === 'agy') {
    // Verified: real 0%-quota capture (2026-09-17) — result.status === 'ERROR', result.error
    // holds "RESOURCE_EXHAUSTED (code 429) ... Resets in 144h14m57s.", preceded by
    // step_update events with step_type: 'error_message' (no message text on the step itself).
    let sawStepError = false;
    for (const event of events) {
      if (event.event === 'step_update' && event.step_update?.step_type === 'error_message') sawStepError = true;
      if (event.event === 'result' || event.type === 'result') {
        const result = event.result || event;
        if (result.status === 'ERROR' || (result.error && String(result.error).trim())) {
          const msg = result.error || `agy result status=${result.status}`;
          flag(msg, { exhausted: isQuotaText(msg), resetHint: parseResetHint(msg) });
        }
      }
      if (event.type === 'error') flag(event.message || 'agy error event', { exhausted: isQuotaText(event.message) });
    }
    if (!failed && sawStepError) flag('agy step_update error_message with no terminal result');
    if (!failed) {
      const line = firstStderrErrorLine(stderr);
      if (line && !text) flag(line, { exhausted: isQuotaText(line) });
    }
  } else if (vendor === 'codex') {
    // Verified via web search (github.com/openai/codex issues + takopi cheatsheet):
    // {"type":"turn.failed","error":{"message":"..."}} and {"type":"error","message":"..."}.
    // Assumed: usage-limit/quota text shape inside that message (no captured example found).
    // Codex also emits transient {"type":"error","message":"Reconnecting... n/5"} while
    // retrying a dropped stream, and a mid-stream {"type":"error",...} can precede a normal
    // turn.completed/agent_message once the retry succeeds — neither is a hard failure unless
    // nothing terminal-success follows it. turn.failed is codex's own terminal failure event
    // and stays unconditionally fatal regardless of what (if anything) follows.
    let pending = null;
    for (const event of events) {
      if (event.type === 'turn.failed') {
        const msg = event.error?.message || 'codex turn.failed';
        flag(msg, { exhausted: isQuotaText(msg), resetHint: parseResetHint(msg) });
        pending = null; // turn.failed is terminal and definitive — a prior transient error must not overwrite it below
      } else if (event.type === 'error' && !/reconnecting/i.test(event.message || '')) {
        const msg = event.message || 'codex error event';
        pending = { msg, exhausted: isQuotaText(msg), resetHint: parseResetHint(msg) };
      } else if (event.item?.type === 'error') {
        pending = { msg: event.item.message || 'codex item error' };
      } else if (event.type === 'turn.completed' || (event.type === 'item.completed' && event.item?.type === 'agent_message')) {
        pending = null;
      }
    }
    if (pending) flag(pending.msg, pending);
  } else if (vendor === 'claude' || vendor === 'cursor') {
    // Verified via code.claude.com/docs/en/errors and web search: result.subtype is
    // 'success' on success, else 'error_max_turns' | 'error_during_execution' |
    // 'error_max_budget_usd' | 'error_max_structured_output_retries' (all start with 'error');
    // result.is_error is the authoritative flag. The result text field is only documented as
    // present on the success subtype, so it is only trusted as the failure reason when
    // is_error is set — otherwise the subtype label is the reason. Quota/auth text
    // (weekly/session/Opus/Sonnet limit, 429, spend limit, login expired, 401, OAuth token)
    // surfaces on stderr, not in the JSON stream. cursor-agent uses the same
    // {type:'result', subtype, is_error} shape (verified via
    // cursor.com/docs/cli/reference/output-format + community reports).
    let sawResult = false;
    for (const event of events) {
      if (event.type === 'result') {
        sawResult = true;
        const subtypeIsError = /^error/.test(event.subtype || '');
        if (event.is_error || subtypeIsError) {
          const msg = event.is_error ? (event.result || `${vendor} result is_error (subtype=${event.subtype || 'unknown'})`) : `${vendor} result subtype=${event.subtype}`;
          flag(msg, { exhausted: isQuotaText(msg) });
        }
      }
    }
    if (!failed) {
      const line = firstStderrErrorLine(stderr) || firstMatchingLine(stderr, QUOTA_RE) || firstMatchingLine(stderr, AUTH_RE);
      if (line && !text) flag(line, { exhausted: isQuotaText(line), resetHint: parseResetHint(line) });
    }
    // A real completion always ends with a type:'result' event (verified: code.claude.com/docs
    // and cursor.com/docs/cli/reference/output-format). A non-zero exit that never produced one
    // — e.g. auth expiry or rate limit killing the process mid-stream, as reported for
    // cursor-agent (github.com/tiann/hapi issue #818) — is a failure even if some assistant
    // text streamed before the crash.
    if (!failed && !sawResult && Number(exitCode) !== 0) {
      flag(`${vendor} exited ${exitCode} before a result event`);
    }
  } else if (vendor === 'opencode') {
    // Verified via takopi cheatsheet: {"type":"error","error":{"name":"APIError","data":
    // {"message":"...","statusCode":429,"isRetryable":true}}}. step_finish.part.reason is
    // documented as only 'stop' | 'tool-calls' — the non-stop/non-tool-calls guard below is a
    // defensive fallback, not a verified failure shape, and is itself treated as terminal (not
    // cleared by a later event). A retryable APIError followed by a later 'text' event or a
    // step_finish reason:'stop' means the run recovered and is not a failure.
    let pending = null;
    for (const event of events) {
      if (event.type === 'error') {
        const msg = event.error?.data?.message || event.error?.message || event.message || 'opencode error event';
        const statusCode = event.error?.data?.statusCode;
        pending = { msg, exhausted: isQuotaText(msg) || statusCode === 429, resetHint: parseResetHint(msg) };
      } else if (event.type === 'text' && event.part?.text) {
        pending = null;
      } else if (event.type === 'step_finish' && event.part?.reason === 'stop') {
        pending = null;
      } else if (event.type === 'step_finish' && event.part?.reason && event.part.reason !== 'tool-calls') {
        flag(`opencode step_finish reason=${event.part.reason}`);
      }
    }
    if (pending) flag(pending.msg, pending);
  } else if (vendor === 'grok') {
    // Verified: existing lib/status.js probe treats a '402' substring as exhausted; folded in
    // here with a tighter, context-requiring pattern (F5) rather than a bare substring test
    // against the whole raw stream, which could false-positive on a successful answer that
    // simply discusses "402". A mid-stream error event followed by real result/response/text
    // later in the stream means the run recovered and is not a failure.
    // event.error can be a plain string ("...error":"HTTP 402...") or an object ({message: ...}).
    const grokErrorText = event => event.message || (typeof event.error === 'string' ? event.error : event.error?.message) || '';
    let pending = null;
    for (const event of events) {
      if (event.type === 'error' || event.error) {
        const msg = grokErrorText(event) || 'grok error event';
        pending = { msg, exhausted: isQuotaText(msg), resetHint: parseResetHint(msg) };
      } else {
        const value = event.result || event.response || event.text;
        if (value != null && String(value).trim()) pending = null;
      }
    }
    if (pending) flag(pending.msg, pending);
    // No `!text` gate here: the regex only ever looks at an error event's own message or
    // stderr — never at the answer text — so a 402 in either of those is real quota exhaustion
    // even if some partial answer text also came through before the CLI reported it (N3).
    const eventText402 = events.some(event => (event.type === 'error' || event.error) && GROK_402_RE.test(grokErrorText(event)));
    if (eventText402 || GROK_402_RE.test(stderr)) {
      flag(reason || 'grok HTTP 402 — quota exhausted', { exhausted: true });
    }
  }

  // Cross-vendor guards (apply to all six):
  if (!failed && exitCode && Number(exitCode) !== 0 && !text) {
    flag(`${vendor} process exited ${exitCode} with no result`);
  }
  if (!failed) {
    const line = firstStderrErrorLine(stderr);
    if (line && !text) flag(line, { exhausted: isQuotaText(line) });
  }

  return { failed, reason, exhausted, resetHint };
}

/**
 * isTerminalEvent(vendor, event) -> boolean
 *
 * Single place of truth for "did this vendor's stream just say it's done" — shapes match the
 * ones classifyFailure() above already parses per vendor (see the per-vendor comments there for
 * provenance). Used by lib/console.js's F6 grace-timer: some vendor CLIs (agy, reproduced live)
 * print their terminal event and then never actually exit the OS process, hanging the job
 * forever with nothing left to do. Detecting the terminal event lets the console start a short
 * grace period and kill the child itself instead of waiting on a process that isn't coming back.
 *
 * - agy: {"event":"result",...} — terminal regardless of result.status (ERROR is still terminal,
 *   just also a failure — classifyFailure handles that separately from console.js's job of
 *   noticing the stream is over).
 * - codex: {"type":"turn.completed"} on success, {"type":"turn.failed"} on its own terminal
 *   failure — both end the turn.
 * - claude & cursor: {"type":"result",...} — both vendors share this shape (see classifyFailure).
 * - opencode: {"type":"step_finish","part":{"reason":"stop"}} ends a normal run. A top-level
 *   {"type":"error",...} is NOT treated as terminal here (M1) — classifyFailure()'s own opencode
 *   branch documents that a retryable APIError can be followed by a later 'text' event or a
 *   step_finish reason:'stop' once opencode's own retry succeeds (live: an opencode 429 mid-stream
 *   followed by a normal completion must not be killed by the grace timer as if the stream were
 *   over). The opencode-error.jsonl fixture (no step_finish after the error at all) is exactly the
 *   case that DOES eventually really end the OS process on its own — nothing here depends on this
 *   function claiming it "ended" early.
 * - grok: emits a single JSON object per invocation (see grok.jsonl / grok-402.jsonl fixtures) —
 *   whichever line arrives (a {"type":"result",...} or a {"type":"error",...}/{"error":...}
 *   shape) is by definition the whole, terminal response (unlike opencode, this is never a
 *   mid-stream retry notice — there is nothing else in the stream to retry into).
 */
function isTerminalEvent(vendor, event) {
  if (!event || typeof event !== 'object') return false;
  switch (vendor) {
    case 'agy':
      return event.event === 'result';
    case 'codex':
      return event.type === 'turn.completed' || event.type === 'turn.failed';
    case 'claude':
    case 'cursor':
      return event.type === 'result';
    case 'opencode':
      return event.type === 'step_finish' && event.part?.reason === 'stop';
    case 'grok':
      // Only the result object is terminal. A mid-stream error may be a retry (see the grok
      // recovery rule in classifyFailure); a hung error falls back to the job timeout.
      return event.type === 'result';
    default:
      return false;
  }
}

module.exports = { classifyFailure, isAuthText, isQuotaText, isTerminalEvent, parseResetHint };

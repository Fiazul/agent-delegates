#!/usr/bin/env bash
# Grok Build worker launcher. Usage:
#   grok-worker.sh run    <tier|model> <brief-file|-> [--name N] [--cd DIR] [--effort low|medium|high] [--yolo]
#   grok-worker.sh interrupt [name]   kill the running job, keep the window;  close [name]  close the window
#   grok-worker.sh resume <session_id>  <message-file|-> [--name N] [--cd DIR] [--yolo]
# Tiers: fast -> grok-4.5 (~Sonnet)   best -> grok-4.6 (~Opus, default)
# Permissions: default sandboxed prompts are auto-denied in -p mode; --yolo = --always-approve.
# HTTP 402 "Grok Build usage balance exhausted" = out of weeklies; nothing to do but wait/reroute.
set -uo pipefail
tier_model(){ case "$1" in fast) echo grok-4.5;; best) echo grok-4.6;; grok-*) echo "$1";; *) echo "unknown tier '$1'">&2; exit 2;; esac; }
PREAMBLE_FILE="$(dirname "$0")/../delegate-codex/worker-preamble.md"
cmd="${1:-}"; shift || true; [[ $cmd == close ]] && { bash "$(dirname "$0")/../delegate-codex/submit-job.sh" "${1:-grok}" --close; exit 0; }
[[ $cmd == interrupt ]] && { bash "$(dirname "$0")/../delegate-codex/submit-job.sh" "${1:-grok}" --interrupt; exit 0; }
[[ $cmd == run || $cmd == resume ]] || { sed -n '2,8p' "$0"; exit 2; }
NAME=grok CD="$PWD" YOLO=0 EFFORT=""
if [[ $cmd == run ]]; then MODEL=$(tier_model "${1:?tier}") || exit 2; BRIEF="${2:?brief}"; shift 2; else SESS="${1:?session}"; BRIEF="${2:?message}"; shift 2; fi
while [[ $# -gt 0 ]]; do case "$1" in --name) NAME="$2"; shift 2;; --cd) CD="$(cd "$2"&&pwd)"; shift 2;; --effort) EFFORT="$2"; shift 2;; --yolo) YOLO=1; shift;; *) echo "unknown flag $1">&2; exit 2;; esac; done
OUT="${CODEX_WORKER_OUT:-/tmp/codex-workers}/${NAME}-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$OUT"
if [[ $BRIEF == - ]]; then cat > "$OUT/brief.md"; else cp "$BRIEF" "$OUT/brief.md"; fi
ARGS=(--cwd "$CD" --output-format json); [[ $YOLO == 1 ]] && ARGS+=(--always-approve); [[ -n $EFFORT ]] && ARGS+=(--effort "$EFFORT")
echo "out=$OUT"
if [[ $cmd == run ]]; then { sed 's/(Codex)/(Grok)/' "$PREAMBLE_FILE"; echo; cat "$OUT/brief.md"; } > "$OUT/prompt.md"; ARGS+=(-m "$MODEL"); echo "model=$MODEL cd=$CD yolo=$YOLO"
else cp "$OUT/brief.md" "$OUT/prompt.md"; ARGS+=(--resume "$SESS"); echo "session=$SESS cd=$CD"; fi
HERE="$(cd "$(dirname "$0")/../delegate-codex" && pwd)"
HDR="▌ BRIEF  grok · ${MODEL:-}"; [[ $cmd == resume ]] && HDR="▌ FOLLOW-UP  grok · same session"
printf 'printf "\\n\\033[1;35m%s\\033[0m\\n"; sed "s/^/▌ /" %q; echo; cd %q; grok' "$HDR" "$OUT/brief.md" "$CD" > "$OUT/run.sh"; printf ' %q' "${ARGS[@]}" -p "$(cat "$OUT/prompt.md")" >> "$OUT/run.sh"; printf ' </dev/null 2> %q | tee %q\n' "$OUT/stderr.log" "$OUT/events.json" >> "$OUT/run.sh"
bash "$HERE/submit-job.sh" "$NAME" "$OUT/run.sh"; rc=$?; echo "$rc" > "$OUT/exit"
python3 - "$OUT" <<'PY'
import json,sys,os
out=sys.argv[1]; raw=open(os.path.join(out,'events.json'),errors='replace').read()
try: d=json.loads(raw)
except Exception: d={}
sid=d.get('session_id') or d.get('sessionId') or ''
err=(d.get('type')=='error') or ('402' in raw and 'exhausted' in raw)
txt=('WORKER FAILED: '+d.get('message','')) if err else (d.get('result') or d.get('response') or d.get('text') or raw)
if err: open(os.path.join(out,'exit'),'w').write('1')
open(os.path.join(out,'session_id'),'w').write(str(sid)); open(os.path.join(out,'last.md'),'w').write(str(txt).strip()+'\n')
print(f"session_id={sid} usage={d.get('usage')}")
PY
rc=$(cat "$OUT/exit"); echo "exit=$rc"; grep -q '402' "$OUT/stderr.log" "$OUT/events.json" 2>/dev/null && { echo "GROK EXHAUSTED (402) — reroute to agy/codex"; date +%F > ~/.grok/.last_402; }
echo "open=grok --resume $(cat "$OUT/session_id")"
echo "--- last message ($OUT/last.md) ---"; cat "$OUT/last.md"; exit $rc

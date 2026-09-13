#!/usr/bin/env bash
# Antigravity (agy) worker launcher — free-tier twin of sonnet5-worker.
# Usage:
#   agy-worker.sh run    <tier|model-slug> <brief-file|-> [--name N] [--cd DIR] [--add-dir D]... [--safe]
#   agy-worker.sh resume <conversation_id> <message-file|-> [--name N] [--cd DIR]
#   agy-worker.sh interrupt [name]   kill the running job, keep the window;  close [name]  close the window
#   agy-worker.sh tiers
# Tiers (agy model slugs; `agy models` for the live list):
#   lite   -> gemini-3.8-flash-low      ~ Haiku    trivial; unreliable, may claim DONE without acting
#   flash  -> gemini-3.8-flash-high     ~ Sonnet   DEFAULT build/fix/test
#   pro    -> gemini-3.1-pro-high       ~ Opus     hard tasks, reviews
#   sonnet -> claude-sonnet-4-6         ~ Sonnet   (Anthropic via Google quota)
#   opus   -> claude-opus-4-6-thinking  ~ Opus     (Anthropic via Google quota)
# Clean room: --disable-slash-commands is always passed (no skill/slash expansion). agy has no switch
#   for its user-global rule (~/.gemini/GEMINI.md, ~800 tokens) or builtin skill catalog; baseline ~14k input tokens.
# Permissions: default --yolo (= --dangerously-skip-permissions; user-authorised 2026-09-13 because headless
#   auto-denies every shell command). --safe = --mode accept-edits (edits only; tested unusable, model dies on `pwd`).
# Output dir: $CODEX_WORKER_OUT (default /tmp/codex-workers)/<name>-<ts>/
#   brief.md prompt.md events.jsonl last.md conversation_id exit stderr.log
set -uo pipefail
tier_model() {
  case "$1" in
    lite) echo gemini-3.8-flash-low ;; flash) echo gemini-3.8-flash-high ;; pro) echo gemini-3.1-pro-high ;;
    sonnet) echo claude-sonnet-4-6 ;; opus) echo claude-opus-4-6-thinking ;;
    *-*) echo "$1" ;;   # raw slug
    *) echo "unknown tier '$1'" >&2; exit 2 ;;
  esac
}
PREAMBLE_FILE="$(dirname "$0")/../delegate-codex/worker-preamble.md"
cmd="${1:-}"; shift || true
case "$cmd" in
  tiers) sed -n '/^# Tiers/,/^# Permissions/p' "$0" | sed 's/^# //'; exit 0 ;;
  run|resume) ;;
  close) bash "$(dirname "$0")/../delegate-codex/submit-job.sh" "${1:-agy}" --close; exit 0 ;;
  interrupt) bash "$(dirname "$0")/../delegate-codex/submit-job.sh" "${1:-agy}" --interrupt; exit 0 ;;
  *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
NAME=agy CD="$PWD" YOLO=1 ADD=()   # yolo default: user authorised 2026-09-13 (headless auto-denies commands otherwise)
if [[ $cmd == run ]]; then MODEL=$(tier_model "${1:?tier}") || exit 2; BRIEF="${2:?brief}"; shift 2
else CONV="${1:?conversation_id}"; BRIEF="${2:?message}"; shift 2; fi
while [[ $# -gt 0 ]]; do case "$1" in
  --name) NAME="$2"; shift 2 ;; --cd) CD="$(cd "$2" && pwd)"; shift 2 ;;
  --add-dir) ADD+=(--add-dir "$2"); shift 2 ;; --yolo) YOLO=1; shift ;; --safe) YOLO=0; shift ;;
  *) echo "unknown flag $1" >&2; exit 2 ;; esac; done
OUT="${CODEX_WORKER_OUT:-/tmp/codex-workers}/${NAME}-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$OUT"
if [[ $BRIEF == - ]]; then cat > "$OUT/brief.md"; else cp "$BRIEF" "$OUT/brief.md"; fi
PERM=(--mode accept-edits); [[ $YOLO == 1 ]] && PERM=(--dangerously-skip-permissions)
echo "out=$OUT"
cd "$CD" || exit 2
ADD+=(--add-dir "$CD")
HERE="$(cd "$(dirname "$0")/../delegate-codex" && pwd)"
if [[ $cmd == run ]]; then
  { sed 's/(Codex)/(Antigravity)/' "$PREAMBLE_FILE"; echo; echo "WORKING DIRECTORY: $CD — every relative path in the brief is relative to this absolute path. Never write into your own scratch/brain directories."; echo; cat "$OUT/brief.md"; } > "$OUT/prompt.md"
  echo "model=$MODEL perm=${PERM[*]} cd=$CD"; SEL="--model $MODEL"
else
  cp "$OUT/brief.md" "$OUT/prompt.md"; echo "conversation=$CONV cd=$CD"; SEL="--conversation $CONV"
fi
HDR="▌ BRIEF  \033[1mantigravity · $MODEL\033[0m  \033[2m(${PERM[*]})\033[0m"; [[ $cmd == resume ]] && HDR="▌ FOLLOW-UP  \033[1mantigravity · same conversation\033[0m"
cat > "$OUT/run.sh" <<RUN
set -o pipefail; cd "$CD"
printf '\n\033[1;35m%b\033[0m\n' "$HDR"; sed 's/^/▌ /' "$OUT/brief.md"; echo
agy $SEL ${PERM[*]} ${ADD[*]} --disable-slash-commands --print-timeout 60m --output-format stream-json -p "\$(cat "$OUT/prompt.md")" </dev/null 2> "$OUT/stderr.log" | tee "$OUT/events.jsonl" | python3 "$HERE/pretty-events.py"
RUN
bash "$HERE/submit-job.sh" "$NAME" "$OUT/run.sh"
rc=$?; echo "$rc" > "$OUT/exit"
python3 - "$OUT" <<'PY'
import json,sys,os
out=sys.argv[1]; conv=''; text=[]; usage=None; tools=0
for line in open(os.path.join(out,'events.jsonl'),errors='replace'):
    try: e=json.loads(line)
    except Exception: continue
    conv = conv or e.get('conversation_id') or (e.get('init') or {}).get('conversation_id') or ''
    if e.get('event')=='step_update' and (e.get('step_update') or {}).get('step_type')=='tool': tools+=1
    if e.get('event')=='result' or 'response' in e:
        r=e.get('result',e); text.append(r.get('response','')); usage=r.get('usage',usage)
    if e.get('event')=='text' or 'text' in e and isinstance(e['text'],str): text.append(e['text'])
open(os.path.join(out,'conversation_id'),'w').write(conv)
open(os.path.join(out,'last.md'),'w').write(''.join(text).strip()+'\n')
print(f"conversation_id={conv} tool_steps={tools//2} usage={usage}")
PY
echo "exit=$rc"; grep -i 'quota\|429\|rate limit\|exhaust' "$OUT/stderr.log" "$OUT/events.jsonl" | head -3 | cut -c1-200
[[ -s "$OUT/last.md" && $(wc -c < "$OUT/last.md") -gt 1 ]] || { echo "--- empty result; stderr: ---"; head -c 600 "$OUT/stderr.log"; echo; }
echo "open=agy --conversation $(cat "$OUT/conversation_id")"
echo "--- last message ($OUT/last.md) ---"; cat "$OUT/last.md"; exit $rc

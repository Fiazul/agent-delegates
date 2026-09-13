#!/usr/bin/env bash
# Codex worker launcher — Codex-side twin of the sonnet5-worker / opus5-reviewer agents.
# Usage:
#   codex-worker.sh run    <tier> <brief-file> [--name N] [--cd DIR] [--ro] [--effort E] [--add-dir D]...
#   codex-worker.sh resume <thread_id> <message-file|-> [--name N] [--cd DIR]   (same --cd as the run)
#   codex-worker.sh interrupt [name]   kill the running job, keep the window;  close [name]  close the window
#   codex-worker.sh tiers
# Tiers (Codex model slugs, mapped to the Claude worker ladder):
#   luna  -> gpt-5.6-luna   ~ Haiku     trivial lookups, formulaic generation
#   terra -> gpt-5.6-terra  ~ Sonnet 5  DEFAULT build/fix/test work
#   sol   -> gpt-5.6-sol    ~ Opus 5    hard tasks, reviews
#   astra -> gpt-6-astra    ~ Fable     hardest architecture / multi-system debugging
# Clean room (default): runs with CODEX_HOME=~/.codex-fresh — only auth.json (symlink to ~/.codex),
#   no user config/AGENTS.md/hooks/MCP/plugins; plugins/goals/memories/image tools disabled.
#   Measured on a trivial prompt: 13k input tokens vs 92k with the full user config.
#   --full   use the real ~/.codex (user skills, hooks, MCP servers, global AGENTS.md).
#   Resume must use the same home the run used (script default = fresh; pass --full if the run did).
# Output dir: $CODEX_WORKER_OUT (default /tmp/codex-workers)/<name>-<ts>/
#   brief.md  events.jsonl  last.md  thread_id  exit
set -uo pipefail

tier_model() {
  case "$1" in
    luna)  echo gpt-5.6-luna ;;
    terra) echo gpt-5.6-terra ;;
    sol)   echo gpt-5.6-sol ;;
    astra) echo gpt-6-astra ;;
    *) echo "unknown tier '$1' (luna|terra|sol|astra)" >&2; exit 2 ;;
  esac
}

PREAMBLE="$(cat "$(dirname "$0")/worker-preamble.md")"

cmd="${1:-}"; shift || true
case "$cmd" in
  tiers) sed -n '/^# Tiers/,/^# Output/p' "$0" | sed 's/^# //'; exit 0 ;;
  run|resume) ;;
  close) bash "$(cd "$(dirname "$0")" && pwd)/../delegate-codex/submit-job.sh" "${1:-codex}" --close; exit 0 ;;
  interrupt) bash "$(dirname "$0")/../delegate-codex/submit-job.sh" "${1:-codex}" --interrupt; exit 0 ;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

NAME=codex CD="$PWD" RO=0 EFFORT=medium ADD=() FULL=0
if [[ $cmd == run ]]; then TIER="${1:?tier}"; BRIEF="${2:?brief-file}"; shift 2; MODEL=$(tier_model "$TIER") || exit 2
else THREAD="${1:?thread_id}"; BRIEF="${2:?message-file}"; shift 2; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --cd) CD="$(cd "$2" && pwd)"; shift 2 ;;
    --ro) RO=1; shift ;;
    --effort) EFFORT="$2"; shift 2 ;;
    --add-dir) ADD+=(--add-dir "$2"); shift 2 ;;
    --full) FULL=1; shift ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
done

OUT="${CODEX_WORKER_OUT:-/tmp/codex-workers}/${NAME}-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
if [[ $BRIEF == - ]]; then cat > "$OUT/brief.md"; else cp "$BRIEF" "$OUT/brief.md"; fi

SANDBOX=workspace-write; [[ $RO == 1 ]] && SANDBOX=read-only
FRESH=()
if [[ $FULL == 0 && -z "${CODEX_HOME:-}" ]]; then
  mkdir -p "$HOME/.codex-fresh"; ln -sfn "$HOME/.codex/auth.json" "$HOME/.codex-fresh/auth.json"
  export CODEX_HOME="$HOME/.codex-fresh"
  FRESH=(--disable plugins --disable recommended_plugins --disable image_generation --disable goals --disable memories)
fi
echo "out=$OUT codex_home=${CODEX_HOME:-$HOME/.codex}"

HERE="$(cd "$(dirname "$0")" && pwd)"
if [[ $cmd == run ]]; then
  { printf '%s\n\n' "$PREAMBLE"; cat "$OUT/brief.md"; } > "$OUT/prompt.md"
  echo "model=$MODEL effort=$EFFORT sandbox=$SANDBOX cd=$CD"
  cat > "$OUT/run.sh" <<RUN
set -o pipefail; export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
printf '\n\033[1;35m▌ BRIEF\033[0m  \033[1mcodex · $MODEL\033[0m  \033[2m(effort $EFFORT · sandbox $SANDBOX · preamble omitted)\033[0m\n'; sed 's/^/▌ /' "$OUT/brief.md"; echo
codex exec --skip-git-repo-check --color never --json -c model_reasoning_summary=detailed ${FRESH[*]} -C "$CD" -s "$SANDBOX" -m "$MODEL" -c "model_reasoning_effort=$EFFORT" ${ADD[*]} -o "$OUT/last.md" - < "$OUT/prompt.md" 2> "$OUT/stderr.log" | tee "$OUT/events.jsonl" | python3 "$HERE/pretty-events.py"
RUN
else
  echo "thread=$THREAD cd=$CD  (resume has no -C flag; pass the same --cd as the run)"
  cat > "$OUT/run.sh" <<RUN
set -o pipefail; export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"; cd "$CD"
printf '\n\033[1;35m▌ FOLLOW-UP\033[0m  \033[1mcodex · same thread\033[0m\n'; sed 's/^/▌ /' "$OUT/brief.md"; echo
codex exec resume --skip-git-repo-check --json -c model_reasoning_summary=detailed ${FRESH[*]} -o "$OUT/last.md" "$THREAD" - < "$OUT/brief.md" 2> "$OUT/stderr.log" | tee "$OUT/events.jsonl" | python3 "$HERE/pretty-events.py"
RUN
fi
bash "$HERE/submit-job.sh" "$NAME" "$OUT/run.sh"
rc=$?
echo "$rc" > "$OUT/exit"
grep -o '"thread_id":"[^"]*"' "$OUT/events.jsonl" | head -1 | cut -d'"' -f4 > "$OUT/thread_id"
echo "exit=$rc thread_id=$(cat "$OUT/thread_id")"
echo "usage=$(grep -o '"usage":{[^}]*}' "$OUT/events.jsonl" | tail -1)"
echo "open=CODEX_HOME=${CODEX_HOME:-$HOME/.codex} codex resume $(cat "$OUT/thread_id")"
echo "--- last message ($OUT/last.md) ---"
cat "$OUT/last.md" 2>/dev/null
exit $rc

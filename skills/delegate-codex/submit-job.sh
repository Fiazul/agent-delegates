#!/usr/bin/env bash
# submit-job.sh <window-name> <job-script>  → runs the job in that window's console (opening the
# window if none is alive), waits, returns the job's exit code.
#   submit-job.sh <name> --interrupt   kill the running job + drop the queue, window stays
#   submit-job.sh <name> --close       close the window (after the current job, if any)
# DELEGATE_NO_WINDOW=1 runs the job inline. DELEGATE_IDLE_MIN (default 10) = idle auto-close.
set -uo pipefail
NAME="$1"; JOB="$2"; ROOT="${DELEGATE_CONSOLE_DIR:-$HOME/.cache/delegates}"; C="$ROOT/$NAME"; HERE="$(cd "$(dirname "$0")" && pwd)"
if [[ $JOB == --close ]]; then touch "$C/stop"; exit 0; fi
if [[ $JOB == --interrupt ]]; then   # kill the running job (whole process group), keep the window
  if [[ -f $C/current.pid ]]; then pkill -TERM -g "$(cat "$C/current.pid")" 2>/dev/null; sleep 1; pkill -KILL -g "$(cat "$C/current.pid" 2>/dev/null)" 2>/dev/null; echo "interrupted job in window $NAME"; else echo "no job running in window $NAME"; fi
  rm -f "$C"/queue/*.job; exit 0; fi   # also drop anything queued behind it
if [[ "${DELEGATE_NO_WINDOW:-0}" == 1 ]]; then bash "$JOB"; exit $?; fi
alive(){ [[ -f $C/pid ]] && kill -0 "$(cat "$C/pid")" 2>/dev/null; }
if [[ -f $C/stop ]]; then for _ in $(seq 1 30); do alive || break; sleep 0.5; done; fi   # a closing console: let it die first
if ! alive; then
  mkdir -p "$C/queue"; rm -f "$C/pid" "$C/stop"
  CMD=(bash "$HERE/console.sh" "$C" "$NAME" "${DELEGATE_IDLE_MIN:-10}")
  if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v gnome-terminal >/dev/null; then gnome-terminal --title="$NAME" --geometry=140x45 -- "${CMD[@]}" >/dev/null 2>&1
  elif [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v x-terminal-emulator >/dev/null; then x-terminal-emulator -T "$NAME" -e "${CMD[@]}" >/dev/null 2>&1 &
  else tmux has-session -t delegates 2>/dev/null || tmux new-session -d -s delegates -n home; tmux new-window -d -t delegates -n "$NAME" "${CMD[*]}"; fi
  for _ in $(seq 1 50); do alive && break; sleep 0.2; done
  alive || { echo "console window failed to start; running inline" >&2; bash "$JOB"; exit $?; }
  echo "window=$NAME (opened)"
else echo "window=$NAME (reused)"; fi
n=$(date +%s%N); cp "$JOB" "$C/queue/$n.job"
while [[ ! -f "$C/queue/$n.exit" ]]; do sleep 1; alive || { echo "console died" >&2; exit 97; }; done
rc=$(cat "$C/queue/$n.exit"); rm -f "$C/queue/$n.exit"; exit "$rc"

#!/usr/bin/env bash
# console.sh <console-dir> <title> <idle-min>
# Runs inside ONE terminal window. Executes job scripts dropped into <console-dir>/queue in order,
# shows their output, writes <job>.exit. Exits (window closes) when <console-dir>/stop exists or
# no job arrives for <idle-min> minutes. Claude never touches this loop; it only drops jobs.
C="$1"; TITLE="$2"; IDLE=$(( ${3:-10} * 60 ))
mkdir -p "$C/queue" "$C/done"; echo $$ > "$C/pid"; rm -f "$C/stop"
exec > >(tee -a "$C/console.log") 2>&1          # everything shown in the window is also logged
printf '\033]0;%s\007\033[1m[%s]\033[0m console up %s — idle-close after %s min\n' "$TITLE" "$TITLE" "$(date +%H:%M:%S)" "${3:-10}"
last=$(date +%s)
while :; do
  job=$(ls "$C/queue"/*.job 2>/dev/null | sort | head -1)
  if [[ -n $job ]]; then
    n=$(basename "$job" .job); printf '\n\033[1;36m━━ job %s  %s ━━\033[0m\n' "$n" "$(date +%H:%M:%S)"
    setsid bash "$job" & jp=$!; echo $jp > "$C/current.pid"; wait $jp; rc=$?; rm -f "$C/current.pid"
    mv "$job" "$C/done/"; echo $rc > "$C/queue/$n.exit"
    (( rc == 143 || rc == 137 )) && printf '\033[1;33m━━ job %s interrupted by orchestrator ━━\033[0m\n' "$n"
    printf '\033[1;33m━━ job %s exit %s ━━\033[0m\n' "$n" "$rc"; last=$(date +%s)
  elif [[ -f $C/stop ]]; then printf '\n\033[2mclosed by orchestrator\033[0m\n'; sleep 2; break
  elif (( $(date +%s) - last > IDLE )); then printf '\n\033[2midle %s min — closing\033[0m\n' "${3:-10}"; sleep 2; break
  else sleep 1; fi
done
rm -f "$C/pid"

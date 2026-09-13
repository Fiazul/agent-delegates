#!/usr/bin/env bash
# agent-delegates installer — symlinks the four skills into every CLI-agent skills dir found,
# adds the `delegates` shell alias, optionally patches the Claude Code statusline.
#   ./install.sh              install (Claude Code ~/.claude/skills + cross-runtime ~/.agents/skills)
#   ./install.sh --statusline also make Claude Code write ~/.claude/rate_limits.json (needed for the claude row)
#   ./install.sh --uninstall  remove the symlinks + alias
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; SK="$HERE/skills"
SKILLS=(delegate-codex delegate-antigravity delegate-grok delegates)
TARGETS=("$HOME/.claude/skills" "$HOME/.agents/skills")     # Claude Code · Codex/Gemini/Copilot cross-runtime dir
ts=$(date +%Y%m%d-%H%M%S)
if [[ "${1:-}" == --uninstall ]]; then
  for t in "${TARGETS[@]}"; do for s in "${SKILLS[@]}"; do [[ -L "$t/$s" ]] && rm "$t/$s" && echo "removed $t/$s"; done; done
  sed -i '/alias delegates=/d' "$HOME/.bashrc" 2>/dev/null || true; echo "alias removed"; exit 0
fi
for t in "${TARGETS[@]}"; do
  mkdir -p "$t"
  for s in "${SKILLS[@]}"; do
    if [[ -e "$t/$s" && ! -L "$t/$s" ]]; then mv "$t/$s" "$t/$s.bak-$ts"; echo "backed up $t/$s -> $s.bak-$ts"; fi
    ln -sfn "$SK/$s" "$t/$s"; echo "linked $t/$s"
  done
done
chmod +x "$SK"/*/*.sh "$SK"/*/*.py 2>/dev/null || true
grep -q 'alias delegates=' "$HOME/.bashrc" 2>/dev/null || { echo "alias delegates='$SK/delegates/delegates.sh'" >> "$HOME/.bashrc"; echo "alias added to ~/.bashrc"; }
if [[ "${1:-}" == --statusline ]]; then
  SL="$HOME/.claude/statusline.sh"
  if [[ -f $SL ]] && ! grep -q 'rate_limits.json' "$SL"; then
    cp "$SL" "$SL.bak-$ts"; { echo '#!/bin/bash'; echo 'input="$(cat)"'; cat "$HERE/extras/statusline-rate-limits.sh"; echo 'printf "%s" "$input" | bash "$0.bak-'"$ts"'"'; } > "$SL"
    echo "statusline patched (original kept as statusline.sh.bak-$ts and still runs)"
  elif [[ ! -f $SL ]]; then cp "$HERE/extras/statusline-minimal.sh" "$SL"; chmod +x "$SL"; echo "installed a minimal statusline at $SL — add it to settings.json: \"statusLine\": {\"type\":\"command\",\"command\":\"bash ~/.claude/statusline.sh\"}"
  else echo "statusline already writes rate_limits.json"; fi
fi
echo; echo "done. try:  $SK/delegates/delegates.sh"
for c in codex agy grok; do command -v $c >/dev/null && echo "  $c: found" || echo "  $c: not installed (its row will say MISSING)"; done

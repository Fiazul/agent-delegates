# --- persist Claude Code rate limits so the `delegates` skill can read them (fail-soft) ---
printf '%s' "$input" | jq -c '{ts: (now|floor), model: .model.display_name, five_hour: .rate_limits.five_hour, seven_day: .rate_limits.seven_day}' > "$HOME/.claude/rate_limits.json.tmp" 2>/dev/null \
  && mv -f "$HOME/.claude/rate_limits.json.tmp" "$HOME/.claude/rate_limits.json" 2>/dev/null

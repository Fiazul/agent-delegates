#!/usr/bin/env bash
# /delegates — quota LEFT + models per CLI. Spends no model tokens (--probe-grok = one tiny paid call).
# Tokenless from Claude Code:  ! ~/.claude/skills/delegates/delegates.sh      (or shell alias `delegates`)
set -uo pipefail
PROBE=0; for a in "$@"; do [[ $a == --probe-grok ]] && PROBE=1; done
left(){ [[ "$1" =~ ^[0-9.]+$ ]] && printf '%d%%' "$(( 100 - ${1%.*} ))" || printf '?'; }
{
echo -e "CLI\tLEFT\tMODELS"
# claude
if [[ -f ~/.claude/rate_limits.json ]]; then
  read -r f w < <(jq -r '[(.five_hour.used_percentage // "?"|tostring),(.seven_day.used_percentage // "?"|tostring)]|join(" ")' ~/.claude/rate_limits.json)
  echo -e "claude\twk $(left "$w") · 5h $(left "$f")\tfable-5.1 opus-5 sonnet-5 haiku-4.5"
else echo -e "claude\tno snapshot\t-"; fi
# codex
python3 - <<'PY'
import json,urllib.request,os
H=os.path.expanduser('~/.codex')
try: models=' '.join(m['slug'] for m in json.load(open(H+'/models_cache.json'))['models'] if not m['slug'].startswith('codex-'))
except Exception: models='?'
a=json.load(open(H+'/auth.json')); t=a.get('tokens') or {}
q='logged out'
if t.get('access_token'):
    try:
        req=urllib.request.Request('https://chatgpt.com/backend-api/wham/usage',headers={'Authorization':'Bearer '+t['access_token'],'ChatGPT-Account-Id':t.get('account_id',''),'User-Agent':'codex-cli'})
        d=json.load(urllib.request.urlopen(req,timeout=20)); rl=d.get('rate_limit') or {}; p=rl.get('primary_window') or {}; s=rl.get('secondary_window') or {}
        r=s.get('reset_after_seconds'); q=f"wk {100-(s.get('used_percent') or 0)}% (reset {r//3600 if r is not None else '?'}h) · 5h {100-(p.get('used_percent') or 0)}%"+('  EXHAUSTED' if rl.get('limit_reached') else '')
    except Exception as e: q=f'usage unavailable'
print(f"codex\t{q}\t{models}")
PY
# agy
python3 - <<'PY'
import json,subprocess
def run(*a): return subprocess.run(['agy',*a],capture_output=True,text=True,timeout=60,stdin=subprocess.DEVNULL,cwd='/tmp').stdout
try:
    import re,collections; fam=collections.OrderedDict()
    for l in run('models').splitlines():
        if '\t' not in l: continue
        slug=l.split('\t')[0]; m=re.match(r'(.*)-(low|medium|high)$',slug)
        fam.setdefault(m.group(1) if m else slug,[]).append(m.group(2)[0] if m else '')
    models=' '.join(k+('{'+'/'.join(v)+'}' if any(v) else '') for k,v in fam.items())
except Exception: models='?'
try:
    d=json.loads(run('--output-format','json','-p','/usage').strip().splitlines()[-1]); parts=[]
    for g in d['command']['data']['groups']:
        b=g['buckets'][0]; parts.append(f"{'gemini' if 'Gemini' in g['name'] else 'claude/gpt'} wk {round(b['remaining_fraction']*100)}%")
    q=' · '.join(parts)
except Exception: q='usage unavailable'
print(f"agy\t{q}\t{models}")
PY
# grok
gm=$(timeout 20 grok models 2>/dev/null | grep -oE 'grok-[0-9.]+' | sort -u | tr '\n' ' ')
if [[ ! -f ~/.grok/auth.json ]]; then q='logged out'
elif [[ $PROBE == 1 ]]; then r=$(cd /tmp && timeout 30 grok -p OK </dev/null 2>&1); if grep -q 402 <<<"$r"; then date +%F > ~/.grok/.last_402; q='exhausted (402)'; else rm -f ~/.grok/.last_402; q='ok'; fi
elif [[ -f ~/.grok/.last_402 ]]; then q="exhausted (402 on $(cat ~/.grok/.last_402))"
else q='unknown (--probe-grok)'; fi
echo -e "grok\t$q\t${gm:-?}"
} | column -t -s $'\t'

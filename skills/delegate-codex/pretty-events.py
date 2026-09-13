#!/usr/bin/env python3
"""stdin: codex --json or agy stream-json → a human-readable live transcript (what the worker says
and does, in plain words). Used inside the worker's terminal window."""
import sys, json, os
B, D, G, Y, R, C, X = '\033[1m', '\033[2m', '\033[32m', '\033[33m', '\033[31m', '\033[36m', '\033[0m'
cwd = os.getcwd(); speaking = False
def rel(p):
    p = str(p or '')
    return os.path.relpath(p, cwd) if p.startswith('/') and p.startswith(cwd) else p
def say(s):                       # a line of activity; closes any streamed sentence first
    global speaking
    if speaking: print(); speaking = False
    print(s, flush=True)
def stream(t):                    # model narrative, streamed inline
    global speaking
    sys.stdout.write(t); sys.stdout.flush(); speaking = True
def body(text, n=20):
    lines = (text or '').replace('\r', '').rstrip().splitlines()
    for l in lines[:n]: say(f"{D}    {l[:200]}{X}")
    if len(lines) > n: say(f"{D}    … {len(lines)-n} more lines{X}")

def agy_tool_line(name, p, state):
    a = lambda *ks: next((p[k] for k in ks if p.get(k)), '')
    if name in ('view_file', 'view_code_item'): return f"{C}reading{X} {rel(a('AbsolutePath','File'))}"
    if name == 'list_dir': return f"{C}listing{X} {rel(a('DirectoryPath'))}/"
    if name in ('grep_search',): return f"{C}searching{X} '{a('Query')}' in {rel(a('SearchPath'))}"
    if name == 'find_by_name': return f"{C}finding{X} {a('Pattern')} under {rel(a('SearchDirectory'))}"
    if name == 'run_command': return f"{C}${X} {a('CommandLine')}"
    if name in ('write_to_file',): return f"{Y}writing{X} {rel(a('TargetFile'))}"
    if name in ('replace_file_content', 'multi_replace_file_content', 'edit_file'): return f"{Y}editing{X} {rel(a('TargetFile'))}"
    if name in ('read_url_content', 'search_web'): return f"{C}web{X} {a('Url','query')}"
    return f"{C}{name}{X} {json.dumps(p)[:160]}"

for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try: e = json.loads(line)
    except Exception: continue
    t = e.get('type') or e.get('event') or ''
    # ------------------------------------------------------------------ codex
    if t == 'thread.started': say(f"{D}codex thread started{X}")
    elif t.startswith('item.'):
        it = e.get('item', {}); k = it.get('type'); done = t == 'item.completed'
        if k == 'command_execution':
            if t == 'item.started': say(f"{C}${X} {it.get('command','')}")
            else:
                body(it.get('aggregated_output')); rc = it.get('exit_code')
                if rc not in (0, None): say(f"{D}    (exit {rc}){X}")
        elif k == 'file_change' and done:
            for ch in it.get('changes', []): say(f"{Y}{ch.get('kind','edit')}{X} {rel(ch.get('path'))}")
        elif k == 'agent_message' and done: say(f"\n{G}▌ worker says{X}\n{it.get('text','')}\n")
        elif k == 'reasoning' and done and (it.get('text') or it.get('summary')):
            say(f"{D}thinking: {(it.get('text') or ' '.join(it.get('summary') or []))[:400]}{X}")
        elif k in ('web_search',) and done: say(f"{C}web{X} {it.get('query','')}")
        elif k == 'error': say(f"{R}WORKER ERROR: {it.get('message', it)}{X}")
    elif t == 'turn.completed': u = e.get('usage', {}); say(f"{D}tokens: in {u.get('input_tokens')} · out {u.get('output_tokens')}{X}")
    elif t == 'error': say(f"{R}WORKER ERROR: {e.get('message', e)}{X}")
    # ------------------------------------------------------------------ agy
    elif t == 'init':
        cwd = e.get('init', {}).get('cwd', cwd); say(f"{D}antigravity · {e.get('init',{}).get('model')}{X}")
    elif t == 'step_update':
        s = e.get('step_update', {}); st, kind = s.get('state'), s.get('step_type')
        if kind == 'agent_response' and st == 'ACTIVE' and s.get('text_delta'): stream(s['text_delta'])
        elif kind == 'agent_response' and st == 'DONE': say('') if speaking else None
        elif kind == 'tool':
            name = s.get('tool_name'); info = s.get('tool_info', {}); p = info.get('parameters', {})
            if st == 'ACTIVE': say(agy_tool_line(name, p, st))
            elif st == 'DONE' and name in ('run_command',): body(info.get('output'))
            elif st == 'DONE' and name in ('grep_search','find_by_name','list_dir') and info.get('output'): body(info.get('output'), 8)
            elif st == 'ERROR': say(f"{Y}    tool error, worker will retry: {s.get('error',{}).get('message','')[:160]}{X}")
    elif t == 'result':
        r = e.get('result', e); u = r.get('usage') or {}
        say(f"\n{G}▌ RESULT{X}\n{r.get('response','')}\n{D}tokens: in {u.get('input_tokens')} · out {u.get('output_tokens')}{X}")
if speaking: print()

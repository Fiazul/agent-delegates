'use strict';

const path = require('node:path');

const ansi = {
  bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', cyan: '\x1b[36m', reset: '\x1b[0m'
};

function colors(enabled) {
  if (enabled) return ansi;
  return Object.fromEntries(Object.keys(ansi).map(key => [key, '']));
}

function relative(file, cwd) {
  const text = String(file || '');
  return path.isAbsolute(text) && text.startsWith(cwd) ? path.relative(cwd, text) : text;
}

function body(text, c, limit = 20) {
  if (Array.isArray(text)) text = text.map(block => block.text || JSON.stringify(block)).join('\n');
  const lines = String(text || '').replace(/\r/g, '').trimEnd().split('\n');
  const shown = lines.slice(0, limit).map(line => `${c.dim}    ${line.slice(0, 200)}${c.reset}`);
  if (lines.length > limit) shown.push(`${c.dim}    … ${lines.length - limit} more lines${c.reset}`);
  return shown;
}

function agyTool(name, params, cwd, c) {
  const pick = (...keys) => keys.map(k => params[k]).find(Boolean) || '';
  if (['view_file', 'view_code_item'].includes(name)) return `${c.cyan}reading${c.reset} ${relative(pick('AbsolutePath', 'File'), cwd)}`;
  if (name === 'list_dir') return `${c.cyan}listing${c.reset} ${relative(pick('DirectoryPath'), cwd)}/`;
  if (name === 'grep_search') return `${c.cyan}searching${c.reset} '${pick('Query')}' in ${relative(pick('SearchPath'), cwd)}`;
  if (name === 'find_by_name') return `${c.cyan}finding${c.reset} ${pick('Pattern')} under ${relative(pick('SearchDirectory'), cwd)}`;
  if (name === 'run_command') return `${c.cyan}$${c.reset} ${pick('CommandLine')}`;
  if (name === 'write_to_file') return `${c.yellow}writing${c.reset} ${relative(pick('TargetFile'), cwd)}`;
  if (['replace_file_content', 'multi_replace_file_content', 'edit_file'].includes(name)) return `${c.yellow}editing${c.reset} ${relative(pick('TargetFile'), cwd)}`;
  if (['read_url_content', 'search_web'].includes(name)) return `${c.cyan}web${c.reset} ${pick('Url', 'query')}`;
  return `${c.cyan}${name}${c.reset} ${JSON.stringify(params).slice(0, 160)}`;
}

function shortInput(input) {
  if (typeof input === 'string') return input.slice(0, 160);
  return JSON.stringify(input || {}).slice(0, 160);
}

class EventRenderer {
  constructor(vendor, options = {}) {
    this.vendor = vendor;
    this.cwd = options.cwd || process.cwd();
    this.c = colors(options.color !== false);
  }

  line(raw) {
    let event;
    try { event = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return []; }
    return this.event(event);
  }

  event(e) {
    const c = this.c;
    const type = e.type || e.event || '';
    if (this.vendor === 'codex') {
      if (type === 'thread.started') return [`${c.dim}codex thread started${c.reset}`];
      if (type === 'turn.completed') {
        const u = e.usage || {};
        return [`${c.dim}tokens: in ${u.input_tokens} · out ${u.output_tokens}${c.reset}`];
      }
      if (type === 'error') return [`${c.red}WORKER ERROR: ${e.message || JSON.stringify(e)}${c.reset}`];
      if (!type.startsWith('item.')) return [];
      const item = e.item || {};
      const done = type === 'item.completed';
      if (item.type === 'command_execution') {
        if (!done) return [`${c.cyan}$${c.reset} ${item.command || ''}`];
        const lines = body(item.aggregated_output, c);
        if (item.exit_code != null && item.exit_code !== 0) lines.push(`${c.dim}    (exit ${item.exit_code})${c.reset}`);
        return lines;
      }
      if (item.type === 'file_change' && done) return (item.changes || []).map(ch => `${c.yellow}${ch.kind || 'edit'}${c.reset} ${relative(ch.path, this.cwd)}`);
      if (item.type === 'agent_message' && done) return [`\n${c.green}▌ worker says${c.reset}\n${item.text || ''}\n`];
      if (item.type === 'reasoning' && done && (item.text || item.summary)) return [`${c.dim}thinking: ${(item.text || (item.summary || []).join(' ')).slice(0, 400)}${c.reset}`];
      if (item.type === 'web_search' && done) return [`${c.cyan}web${c.reset} ${item.query || ''}`];
      if (item.type === 'error') return [`${c.red}WORKER ERROR: ${item.message || JSON.stringify(item)}${c.reset}`];
      return [];
    }

    if (this.vendor === 'agy') {
      if (type === 'init') {
        this.cwd = e.init?.cwd || this.cwd;
        return [`${c.dim}antigravity · ${e.init?.model || ''}${c.reset}`];
      }
      if (type === 'result') {
        const r = e.result || e;
        const u = r.usage || {};
        return [`\n${c.green}▌ RESULT${c.reset}\n${r.response || ''}\n${c.dim}tokens: in ${u.input_tokens} · out ${u.output_tokens}${c.reset}`];
      }
      if (type !== 'step_update') return [];
      const step = e.step_update || {};
      if (step.step_type === 'agent_response' && step.state === 'ACTIVE' && step.text_delta) return [step.text_delta];
      if (step.step_type !== 'tool') return [];
      const info = step.tool_info || {};
      if (step.state === 'ACTIVE') return [agyTool(step.tool_name, info.parameters || {}, this.cwd, c)];
      if (step.state === 'DONE' && step.tool_name === 'run_command') return body(info.output, c);
      if (step.state === 'DONE' && ['grep_search', 'find_by_name', 'list_dir'].includes(step.tool_name) && info.output) return body(info.output, c, 8);
      if (step.state === 'ERROR') return [`${c.yellow}    tool error, worker will retry: ${(step.error?.message || '').slice(0, 160)}${c.reset}`];
      return [];
    }

    if (this.vendor === 'claude' || this.vendor === 'cursor') {
      const label = this.vendor === 'cursor' ? 'cursor' : 'claude';
      if (type === 'system' && e.subtype === 'init') return [`${c.dim}${label} session started · ${e.model || ''}${c.reset}`];
      if (type === 'assistant') {
        const content = e.message?.content || [];
        return content.flatMap(block => {
          if (block.type === 'text') return [block.text || ''];
          if (block.type === 'tool_use') return [`${c.cyan}${block.name || 'tool'}${c.reset} ${shortInput(block.input)}`];
          return [];
        });
      }
      if (type === 'user') {
        return (e.message?.content || []).flatMap(block => block.type === 'tool_result' ? body(block.content, c, 8) : []);
      }
      if (type === 'result') {
        const usage = e.usage || {};
        const failure = e.is_error ? c.red : c.green;
        const input = usage.input_tokens ?? usage.inputTokens;
        const output = usage.output_tokens ?? usage.outputTokens;
        return [`\n${failure}▌ RESULT${c.reset}\n${e.result || ''}\n${c.dim}tokens: in ${input} · out ${output}${c.reset}`];
      }
      return [];
    }

    if (this.vendor === 'opencode') {
      if (type === 'step_start') return [`${c.dim}opencode · ${e.sessionID || ''}${c.reset}`];
      if (type === 'text' && e.part?.text) return [e.part.text];
      if (type === 'tool_use') {
        const part = e.part || {};
        const state = part.state || {};
        return [`${c.cyan}${part.tool || 'tool'}${c.reset} ${shortInput(state.input)}`];
      }
      if (type === 'step_finish') {
        const tokens = e.part?.tokens || {};
        const failure = e.part?.reason && e.part.reason !== 'stop' && e.part.reason !== 'tool-calls' ? c.red : c.green;
        return [`\n${failure}▌ RESULT${c.reset}\n${c.dim}tokens: in ${tokens.input} · out ${tokens.output}${c.reset}`];
      }
      if (type === 'error') return [`${c.red}WORKER ERROR: ${e.message || e.error?.message || JSON.stringify(e)}${c.reset}`];
      return [];
    }

    if (type === 'error' || e.error) return [`${c.red}WORKER ERROR: ${e.message || e.error?.message || JSON.stringify(e)}${c.reset}`];
    const result = e.result || e.response || e.text;
    return result ? [`\n${c.green}▌ RESULT${c.reset}\n${typeof result === 'string' ? result : JSON.stringify(result)}\n`] : [];
  }
}

module.exports = { EventRenderer };

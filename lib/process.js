'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

function resolveCommand(command, args, env = process.env, platform = process.platform) {
  if (platform !== 'win32' || path.extname(command)) return { command, args };
  for (const directory of (env.PATH || env.Path || '').split(';')) {
    for (const extension of ['.exe', '.cmd']) {
      const file = path.join(directory, command + extension);
      if (!fs.existsSync(file)) continue;
      if (extension === '.exe') return { command: file, args };
      const shim = fs.readFileSync(file, 'utf8');
      const match = shim.match(/"(%~dp0|%dp0%)([^"\r\n]+\.(?:js|cjs|mjs))"/i);
      if (match) {
        return { command: process.execPath, args: [path.resolve(directory, match[2]), ...args] };
      }
      throw new Error('Unsupported Windows command shim for ' + command + '; install its native executable or standard npm launcher');
    }
  }
  return { command, args };
}

function spawn(command, args, options = {}) {
  const resolved = resolveCommand(command, args, options.env || process.env);
  return childProcess.spawn(resolved.command, resolved.args, options);
}

module.exports = { resolveCommand, spawn };

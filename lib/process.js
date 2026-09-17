'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

// A .cmd/.bat npm-style shim doesn't run directly under child_process.spawn (no shell) — it's a
// batch script wrapping `node "%~dp0\...\real.js" %*`. Unwrap it to the real underlying script so
// spawn() can run `node real.js` directly, exactly the way the pre-existing bare-name PATH search
// below already did.
function unwrapCmdShim(file, args) {
  const shim = fs.readFileSync(file, 'utf8');
  const match = shim.match(/"(%~dp0|%dp0%)([^"\r\n]+\.(?:js|cjs|mjs))"/i);
  if (match) {
    return { command: process.execPath, args: [path.resolve(path.dirname(file), match[2]), ...args] };
  }
  throw new Error('Unsupported Windows command shim for ' + file + '; install its native executable or standard npm launcher');
}

function resolveCommand(command, args, env = process.env, platform = process.platform) {
  if (platform !== 'win32') return { command, args };

  const ext = path.extname(command).toLowerCase();
  // M5: a command that already carries a .cmd/.bat extension — e.g. an absolute path handed
  // back by lib/bins.js's resolveBin from a well-known install dir or a routing.json override,
  // not just a bare name resolved via the PATH search below — must still be unwrapped. The old
  // check (`path.extname(command)` truthy -> return unchanged) silently skipped this for any
  // already-resolved path, which meant a real .cmd shim resolved outside of PATH search was
  // handed to spawn() unshimmed and would never actually launch.
  if (ext === '.cmd' || ext === '.bat') {
    return fs.existsSync(command) ? unwrapCmdShim(command, args) : { command, args };
  }
  if (ext) return { command, args }; // .exe (or anything else) already resolved -> use as-is

  // M5: on win32, PATHEXT/CreateProcess conventions never run a bare extensionless file as an
  // executable — only .exe/.cmd/.bat (etc.) are launchable — so an extensionless candidate must
  // never be tried, only skipped straight to the real launchable extensions, .exe preferred.
  for (const directory of (env.PATH || env.Path || '').split(';')) {
    for (const extension of ['.exe', '.cmd']) {
      const file = path.join(directory, command + extension);
      if (!fs.existsSync(file)) continue;
      if (extension === '.exe') return { command: file, args };
      return unwrapCmdShim(file, args);
    }
  }
  return { command, args };
}

function spawn(command, args, options = {}) {
  const resolved = resolveCommand(command, args, options.env || process.env);
  return childProcess.spawn(resolved.command, resolved.args, options);
}

module.exports = { resolveCommand, spawn };

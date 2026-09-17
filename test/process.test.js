'use strict';

// M5: lib/process.js's resolveCommand() handles Windows executable resolution — on win32 only
// .exe/.cmd/.bat are ever launchable (an extensionless file is never invoked by CreateProcess/
// PATHEXT conventions), and a .cmd/.bat npm-style shim must be unwrapped to the real underlying
// script regardless of whether it arrived as a bare PATH-searched name or an already-resolved
// absolute path. resolveCommand takes an injectable `platform` argument specifically so this is
// testable on a non-Windows CI host.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveCommand } = require('../lib/process');

function cmdShim(realJsPath) {
  return `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%${realJsPath}" %*\r\n`;
}

test('resolveCommand: non-win32 platform never touches PATH or extensions', () => {
  const result = resolveCommand('cursor-agent', ['--foo'], { PATH: '/nonexistent' }, 'linux');
  assert.deepEqual(result, { command: 'cursor-agent', args: ['--foo'] });
});

test('resolveCommand: win32, bare name resolves via PATH, preferring .exe over .cmd (M5)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-process-win-'));
  fs.writeFileSync(path.join(dir, 'thing.exe'), 'binary');
  fs.writeFileSync(path.join(dir, 'thing.cmd'), cmdShim('..\\real.js'));
  const result = resolveCommand('thing', [], { PATH: dir }, 'win32');
  assert.equal(result.command, path.join(dir, 'thing.exe'));
});

test('resolveCommand: win32, bare name never tries the extensionless candidate (M5)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-process-win-'));
  // Only an extensionless file exists — must NOT be picked; falls through to the unresolved
  // bare command (matches the pre-existing "nothing found -> return unchanged" behavior).
  fs.writeFileSync(path.join(dir, 'thing'), 'not launchable on windows');
  const result = resolveCommand('thing', ['x'], { PATH: dir }, 'win32');
  assert.deepEqual(result, { command: 'thing', args: ['x'] });
});

test('resolveCommand: win32, bare name resolves to a .cmd shim and unwraps it to the real .js (M5)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-process-win-'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'real.js'), '// real entry\n');
  // Forward slashes in the captured path (real npm shims work with either): path.resolve() below
  // uses the host's native path module, and a literal backslash isn't a separator on a POSIX
  // test host, so this keeps the assertion meaningful cross-platform.
  fs.writeFileSync(path.join(dir, 'thing.cmd'), cmdShim('lib/real.js'));
  const result = resolveCommand('thing', ['--x'], { PATH: dir }, 'win32');
  assert.equal(result.command, process.execPath);
  assert.equal(result.args[0], path.resolve(dir, 'lib', 'real.js'));
  assert.deepEqual(result.args.slice(1), ['--x']);
});

// M5: the bug this specifically fixes — an already-resolved ABSOLUTE .cmd path (e.g. handed back
// by lib/bins.js's resolveBin from a well-known install dir or a routing.json override, not
// found via the PATH search above) used to be returned completely unchanged (the old
// `path.extname(command)` truthy check short-circuited before ever looking at PATH or shims),
// which meant spawn() got a raw .cmd path it cannot execute directly without a shell.
test('resolveCommand: win32, an already-resolved ABSOLUTE .cmd path is unwrapped too, not just a bare PATH-resolved name (M5)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-process-win-'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'real.js'), '// real entry\n');
  const absoluteCmd = path.join(dir, 'thing.cmd');
  fs.writeFileSync(absoluteCmd, cmdShim('lib/real.js'));

  const result = resolveCommand(absoluteCmd, ['--y'], { PATH: '' }, 'win32');
  assert.equal(result.command, process.execPath);
  assert.equal(result.args[0], path.resolve(dir, 'lib', 'real.js'));
  assert.deepEqual(result.args.slice(1), ['--y']);
});

test('resolveCommand: win32, an already-resolved .exe path is returned unchanged (no unwrap attempted)', () => {
  const result = resolveCommand('C:\\Program Files\\thing\\thing.exe', ['--z'], {}, 'win32');
  assert.deepEqual(result, { command: 'C:\\Program Files\\thing\\thing.exe', args: ['--z'] });
});

test('resolveCommand: win32, an absolute .cmd path that does not exist on disk is returned unchanged rather than throwing', () => {
  const result = resolveCommand('C:\\nowhere\\thing.cmd', [], {}, 'win32');
  assert.deepEqual(result, { command: 'C:\\nowhere\\thing.cmd', args: [] });
});

test('resolveCommand: win32, an unrecognized .cmd shim format throws a clear "unsupported shim" error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegates-process-win-'));
  fs.writeFileSync(path.join(dir, 'thing.cmd'), '@ECHO off\r\nrem not an npm-style shim at all\r\n');
  assert.throws(() => resolveCommand('thing', [], { PATH: dir }, 'win32'), /Unsupported Windows command shim/);
});

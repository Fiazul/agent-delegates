'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { spawn } = require('./process');
const { EventRenderer } = require('./renderer');
const { homeDir, packageRoot, shellQuote, sleep } = require('./util');

function consoleRoot() {
  if (process.env.DELEGATE_CONSOLE_DIR) return process.env.DELEGATE_CONSOLE_DIR;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || homeDir(), 'delegates');
  return path.join(homeDir(), '.cache', 'delegates');
}

function consoleDir(name) {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') throw new Error(`invalid window name '${name}'`);
  return path.join(consoleRoot(), name);
}

function alive(pidFile) {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

class Mirror {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
  }

  write(text) {
    process.stdout.write(text);
    fs.appendFileSync(this.file, text);
  }
}

function renderedWrite(mirror, rendered) {
  for (const text of rendered) {
    mirror.write(text);
    if (!text.endsWith('\n')) mirror.write('\n');
  }
}

async function executeJob(job, directory, mirror) {
  const outDir = job.outDir;
  fs.mkdirSync(outDir, { recursive: true });
  const eventsFile = path.join(outDir, 'events.jsonl');
  const stderrFile = path.join(outDir, 'stderr.log');
  fs.writeFileSync(eventsFile, '');
  fs.writeFileSync(stderrFile, '');
  mirror.write(`\n\x1b[1;35m${job.header}\x1b[0m\n`);
  const brief = path.join(outDir, 'brief.md');
  if (fs.existsSync(brief)) {
    const display = fs.readFileSync(brief, 'utf8').split(/\r?\n/).map(line => `▌ ${line}`).join('\n');
    mirror.write(`${display}\n\n`);
  }

  const env = { ...process.env, ...(job.env || {}) };
  const stdinFile = env.DELEGATE_STDIN_FILE;
  delete env.DELEGATE_STDIN_FILE;
  const input = stdinFile ? fs.openSync(stdinFile, 'r') : 'ignore';
  const child = spawn(job.cmd, job.args || [], {
    cwd: job.cwd,
    env,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: [input, 'pipe', 'pipe']
  });
  if (stdinFile) fs.closeSync(input);
  fs.writeFileSync(path.join(directory, 'current.pid'), String(child.pid));
  const renderer = new EventRenderer(job.env?.DELEGATE_VENDOR || '', { cwd: job.cwd, color: true });
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    fs.appendFileSync(eventsFile, chunk);
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) if (line.trim()) renderedWrite(mirror, renderer.line(line));
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    fs.appendFileSync(stderrFile, chunk);
    mirror.write(`\x1b[2m${chunk}\x1b[0m`);
  });
  const code = await new Promise(resolve => {
    child.on('error', error => {
      const message = `${error.message}\n`;
      fs.appendFileSync(stderrFile, message);
      mirror.write(`\x1b[31mWORKER ERROR: ${error.message}\x1b[0m\n`);
      resolve(127);
    });
    child.on('close', (status, signal) => resolve(status == null ? (signal ? 143 : 1) : status));
  });
  if (pending.trim()) renderedWrite(mirror, renderer.line(pending));
  try { fs.unlinkSync(path.join(directory, 'current.pid')); } catch {}
  return code;
}

async function runConsole(directory, title, idleMinutes = 10, options = {}) {
  const queue = path.join(directory, 'queue');
  const done = path.join(directory, 'done');
  fs.mkdirSync(queue, { recursive: true });
  fs.mkdirSync(done, { recursive: true });
  const stop = path.join(directory, 'stop');
  try { fs.unlinkSync(stop); } catch {}
  const pidFile = path.join(directory, 'pid');
  fs.writeFileSync(pidFile, String(process.pid));
  const mirror = new Mirror(path.join(directory, 'console.log'));
  mirror.write(`\x1b]0;${title}\x07\x1b[1m[${title}]\x1b[0m console up ${new Date().toLocaleTimeString()} — idle-close after ${idleMinutes} min\n`);
  let last = Date.now();
  try {
    while (true) {
      const jobs = fs.readdirSync(queue).filter(file => file.endsWith('.job')).sort();
      if (jobs.length) {
        const filename = jobs[0];
        const id = filename.slice(0, -4);
        const jobFile = path.join(done, filename);
        fs.renameSync(path.join(queue, filename), jobFile);
        mirror.write(`\n\x1b[1;36m━━ job ${id}  ${new Date().toLocaleTimeString()} ━━\x1b[0m\n`);
        let code = 1;
        try {
          const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
          code = await executeJob(job, directory, mirror);
        } catch (error) {
          mirror.write(`\x1b[31mWORKER ERROR: ${error.message}\x1b[0m\n`);
        }
        fs.writeFileSync(path.join(queue, `${id}.exit`), String(code));
        if ([137, 143].includes(code)) mirror.write(`\x1b[1;33m━━ job ${id} interrupted by orchestrator ━━\x1b[0m\n`);
        mirror.write(`\x1b[1;33m━━ job ${id} exit ${code} ━━\x1b[0m\n`);
        last = Date.now();
        if (options.once) break;
      } else if (fs.existsSync(stop)) {
        mirror.write('\n\x1b[2mclosed by orchestrator\x1b[0m\n');
        break;
      } else if (Date.now() - last > idleMinutes * 60000) {
        mirror.write(`\n\x1b[2midle ${idleMinutes} min — closing\x1b[0m\n`);
        break;
      } else {
        await sleep(250);
      }
    }
  } finally {
    try { fs.unlinkSync(pidFile); } catch {}
  }
}

function detached(command, args) {
  return new Promise(resolve => {
    let done = false;
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', () => { if (!done) { done = true; resolve(false); } });
    child.once('spawn', () => { if (!done) { done = true; child.unref(); resolve(true); } });
  });
}

async function spawnWindow(directory, title, idleMinutes) {
  const cli = path.join(packageRoot(), 'bin', 'cli.js');
  const command = [process.execPath, cli, '_console', directory, title, String(idleMinutes)];
  const launch = async (executable, args) => {
    if (!await detached(executable, args)) return false;
    for (let i = 0; i < 20; i++) {
      if (alive(path.join(directory, 'pid'))) return true;
      await sleep(100);
    }
    return false;
  };
  if (process.platform === 'darwin') {
    const line = command.map(shellQuote).join(' ');
    return launch('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(line)}`]);
  }
  if (process.platform === 'win32') {
    const line = command.map(shellQuote).join(' ');
    if (await launch('wt.exe', ['-w', '0', 'nt', '--title', title, 'cmd', '/k', line])) return true;
    return launch('cmd.exe', ['/c', 'start', title, 'cmd', '/k', line]);
  }
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    if (await launch('gnome-terminal', [`--title=${title}`, '--geometry=140x45', '--', ...command])) return true;
    if (await launch('x-terminal-emulator', ['-T', title, '-e', ...command])) return true;
    if (await launch('konsole', ['-p', `tabtitle=${title}`, '-e', ...command])) return true;
    if (await launch('xterm', ['-T', title, '-e', ...command])) return true;
  }
  const hasSession = spawnSync('tmux', ['has-session', '-t', 'delegates'], { stdio: 'ignore' }).status === 0;
  if (!hasSession) spawnSync('tmux', ['new-session', '-d', '-s', 'delegates', '-n', 'home'], { stdio: 'ignore' });
  return spawnSync('tmux', ['new-window', '-d', '-t', 'delegates', '-n', title, command.map(shellQuote).join(' ')], { stdio: 'ignore' }).status === 0;
}

async function submitJob(name, job) {
  const directory = consoleDir(name);
  const queue = path.join(directory, 'queue');
  fs.mkdirSync(queue, { recursive: true });
  const id = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const jobFile = path.join(queue, `${id}.job`);
  fs.writeFileSync(jobFile + '.tmp', `${JSON.stringify(job)}\n`);
  fs.renameSync(jobFile + '.tmp', jobFile);
  const pidFile = path.join(directory, 'pid');
  let consoleChild = null;

  if (process.env.DELEGATE_NO_WINDOW === '1') {
    const cli = path.join(packageRoot(), 'bin', 'cli.js');
    consoleChild = spawn(process.execPath, [cli, '_console', directory, name, process.env.DELEGATE_IDLE_MIN || '10', '--once'], { stdio: 'inherit' });
    console.log(`window=${name} (inline)`);
  } else {
    if (fs.existsSync(path.join(directory, 'stop'))) {
      for (let i = 0; i < 30 && alive(pidFile); i++) await sleep(500);
    }
    if (!alive(pidFile)) {
      try { fs.unlinkSync(pidFile); } catch {}
      try { fs.unlinkSync(path.join(directory, 'stop')); } catch {}
      const started = await spawnWindow(directory, name, Number(process.env.DELEGATE_IDLE_MIN || 10));
      if (started) for (let i = 0; i < 50 && !alive(pidFile); i++) await sleep(200);
      if (!alive(pidFile)) {
        console.error('console window failed to start; running inline');
        const cli = path.join(packageRoot(), 'bin', 'cli.js');
        consoleChild = spawn(process.execPath, [cli, '_console', directory, name, process.env.DELEGATE_IDLE_MIN || '10', '--once'], { stdio: 'inherit' });
      } else console.log(`window=${name} (opened)`);
    } else console.log(`window=${name} (reused)`);
  }

  const exitFile = path.join(queue, `${id}.exit`);
  let childEnded = false;
  if (consoleChild) {
    consoleChild.once('error', () => { childEnded = true; });
    consoleChild.once('close', () => { childEnded = true; });
  }
  while (!fs.existsSync(exitFile)) {
    await sleep(250);
    if (!fs.existsSync(exitFile) && childEnded) throw new Error('inline console died before completing job');
    if (!consoleChild && !alive(pidFile)) throw new Error('console died');
  }
  const code = Number(fs.readFileSync(exitFile, 'utf8'));
  fs.unlinkSync(exitFile);
  if (consoleChild && consoleChild.exitCode == null) await new Promise(resolve => consoleChild.on('close', resolve));
  return code;
}

async function interrupt(name) {
  const directory = consoleDir(name);
  const current = path.join(directory, 'current.pid');
  if (!fs.existsSync(current)) {
    console.log(`no job running in window ${name}`);
  } else {
    const pid = Number(fs.readFileSync(current, 'utf8'));
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else {
      try { process.kill(-pid, 'SIGTERM'); } catch {}
      await sleep(1000);
      try { process.kill(-pid, 'SIGKILL'); } catch {}
    }
    console.log(`interrupted job in window ${name}`);
  }
  const queue = path.join(directory, 'queue');
  if (fs.existsSync(queue)) for (const file of fs.readdirSync(queue)) if (file.endsWith('.job')) {
    try {
      fs.unlinkSync(path.join(queue, file));
      fs.writeFileSync(path.join(queue, file.slice(0, -4) + '.exit'), '143');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function close(name) {
  const directory = consoleDir(name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'stop'), '');
  console.log(`close requested for window ${name}`);
}

module.exports = { close, consoleDir, consoleRoot, executeJob, interrupt, runConsole, submitJob };

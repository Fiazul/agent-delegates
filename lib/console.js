'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { spawn } = require('./process');
const { EventRenderer } = require('./renderer');
const { isTerminalEvent } = require('./failure');
const { homeDir, packageRoot, shellQuote, sleep } = require('./util');

// F6: some vendor CLIs (agy, reproduced live 2026-09-17: printed its terminal `{"event":"result",
// ...}` at t+212s, then the OS process itself stayed alive past t+400s) print their terminal
// event and then never actually exit — hanging the job (and the console) forever with nothing
// left to consume. Once a terminal event is seen in the stream, give the process a short grace
// period to exit on its own before killing it ourselves.
const DEFAULT_TERMINAL_GRACE_MS = 20000;

function consoleRoot() {
  if (process.env.DELEGATE_CONSOLE_DIR) return process.env.DELEGATE_CONSOLE_DIR;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || homeDir(), 'delegates');
  return path.join(homeDir(), '.cache', 'delegates');
}

function consoleDir(name) {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') throw new Error(`invalid window name '${name}'`);
  return path.join(consoleRoot(), name);
}

function readFileOrNull(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// M2: `Number(null)` and `Number('')` are both `0`, which a bare `Number.isFinite` check happily
// accepted — an empty (or not-yet-written) `.started` placeholder file must never resolve to
// deadline = epoch (instant cancel, spurious 124 the moment submitJob's wait loop first polls).
// Only a genuine positive timestamp counts as "started".
function readStartedAt(file) {
  const startedAt = Number(readFileOrNull(file));
  return Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null;
}

// F5: a console's `pid` file is heartbeat-touched (mtime) roughly every 10s while it runs
// (see the setInterval in runConsole). If the mtime is stale beyond this window the file
// almost certainly survived a reboot/crash of a host whose pid got reassigned to something
// else entirely — treat it as dead rather than trust a bare `kill(pid, 0)` liveness check.
const HEARTBEAT_STALE_MS = 60000;

function alive(pidFile) {
  try {
    const stat = fs.statSync(pidFile);
    if (Date.now() - stat.mtimeMs > HEARTBEAT_STALE_MS) return false;
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

// F4: current.pid used to be a bare pid integer, which `interrupt()` would blindly kill -
// including a pid that had since been reused by an unrelated process. It now carries the pid
// alongside the command that was run and when, so interrupt() can sanity-check the target
// before sending a signal. Legacy bare-integer files (or files from an older version of this
// tool) are still read as `{ pid }` with no `cmd` to verify against.
function readCurrentPid(file) {
  const raw = readFileOrNull(file);
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const info = JSON.parse(trimmed);
      return Number.isInteger(info.pid) && info.pid > 0 ? info : null;
    } catch { return null; }
  }
  const pid = Number(trimmed);
  return Number.isInteger(pid) && pid > 0 ? { pid } : null;
}

function writeCurrentPid(file, pid, cmd) {
  fs.writeFileSync(file, JSON.stringify({ pid, startedAt: Date.now(), cmd: String(cmd) }));
}

// Best-effort ownership check before interrupt() sends a signal to a recorded pid. Only
// implemented on Linux (via /proc) — elsewhere we trust the recorded pid, same as before this
// fix. A legacy bare-integer file has no `cmd` to check against, so it's trusted too.
function verifyProcessOwnership(info) {
  if (!info) return false;
  if (process.platform !== 'linux' || !info.cmd) return true;
  try {
    const cmdline = fs.readFileSync(`/proc/${info.pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    if (!cmdline) return false;
    return cmdline.includes(info.cmd) || info.cmd.includes(cmdline.split(' ')[0]);
  } catch { return false; }
}

class Mirror {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
  }

  write(text) {
    // M3: with DELEGATE_QUIET set (tests) the mirrored console text is never written to this
    // process's own stdout — only appended to the on-disk console.log. This process's stdout may
    // be a fd shared with something that can't tolerate arbitrary interleaved bytes (e.g. the
    // node test runner's own structured reporting channel, corrupted by a console subprocess's
    // raw/ANSI output landing on the same fd — see M3 in TODO.md/CLAUDE.md history).
    if (!process.env.DELEGATE_QUIET) process.stdout.write(text);
    fs.appendFileSync(this.file, text);
  }
}

function renderedWrite(mirror, rendered) {
  for (const text of rendered) {
    mirror.write(text);
    if (!text.endsWith('\n')) mirror.write('\n');
  }
}

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try { process.kill(-pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} }, 1000).unref();
  }
}

// F1: with the worker spawned `detached: true` it sits in its own process group and does NOT
// receive SIGINT/SIGTERM/SIGHUP forwarded to this process's group (e.g. Ctrl-C in the terminal
// that started an inline console). Left unhandled, the signal kills this process outright and
// orphans the worker. Both `runConsole` (the actual job consumer) and submitJob's inline
// fallback (which spawns `_console` as a foreground child sharing this process's group) install
// this so a signal here kills whatever worker tree is currently recorded in `current.pid` before
// exiting with the conventional 128+signal code.
const SIGNAL_EXIT_CODE = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

function installSignalHandlers(directory) {
  const currentPidFile = path.join(directory, 'current.pid');
  const handlers = {};
  const teardown = () => {
    for (const [signal, handler] of Object.entries(handlers)) process.removeListener(signal, handler);
  };
  for (const signal of Object.keys(SIGNAL_EXIT_CODE)) {
    handlers[signal] = () => {
      try {
        const info = readCurrentPid(currentPidFile);
        if (info) killTree(info.pid);
      } catch {}
      try { fs.unlinkSync(currentPidFile); } catch {}
      teardown();
      process.exit(SIGNAL_EXIT_CODE[signal]);
    };
    process.on(signal, handlers[signal]);
  }
  return teardown;
}

// F3: guards the check-pid / spawn-window section of submitJob so two concurrent submitJob
// calls for the same window can't both observe "no live console" and both spawn one. The
// O_EXCL create is the atomic part; a stale lock (crash before release) is cleared after
// SPAWN_LOCK_STALE_MS so a dead lock owner can't wedge every future submission.
const SPAWN_LOCK_STALE_MS = 30000;

function acquireSpawnLock(directory) {
  const lockFile = path.join(directory, 'spawn.lock');
  try {
    const stat = fs.statSync(lockFile);
    if (Date.now() - stat.mtimeMs > SPAWN_LOCK_STALE_MS) { try { fs.unlinkSync(lockFile); } catch {} }
  } catch {}
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.closeSync(fs.openSync(lockFile, 'wx'));
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

function releaseSpawnLock(directory) {
  try { fs.unlinkSync(path.join(directory, 'spawn.lock')); } catch {}
}

// Cancellation watcher: the *submitting* process (submitJob, possibly in a different OS
// process — a persistent console window) drops `<id>.cancel` into the queue dir when its own
// wait loop exceeds the job's timeout. This poller (running alongside the child inside
// executeJob, i.e. the actual consumer) notices the file, kills the child's process tree, and
// consumes (deletes) the marker so it never leaks into a later job with a different id.
function watchForCancel(directory, id, onCancel) {
  if (!id) return null;
  const cancelFile = path.join(directory, 'queue', `${id}.cancel`);
  return setInterval(() => {
    if (fs.existsSync(cancelFile)) {
      try { fs.unlinkSync(cancelFile); } catch {}
      onCancel();
    }
  }, 1000);
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
  const currentPidFile = path.join(directory, 'current.pid');
  writeCurrentPid(currentPidFile, child.pid, job.cmd);
  let cancelTimer = null;
  let graceTimer = null;
  try {
    let cancelled = false;
    let gracedKill = false;
    // Stamp the actual execution start (not submission time): a job queued behind another job
    // can sit for a while before the consumer even looks at it, and submitJob's timeout clock
    // must run from here, or a job that waited its turn gets wrongly cancelled before it had a
    // fair run of its own timeout window.
    if (job.id) { try { fs.writeFileSync(path.join(directory, 'queue', `${job.id}.started`), String(Date.now())); } catch {} }
    cancelTimer = watchForCancel(directory, job.id, () => {
      cancelled = true;
      mirror.write('\x1b[31mWORKER TIMED OUT — cancelling\x1b[0m\n');
      killTree(child.pid);
    });
    const vendor = job.env?.DELEGATE_VENDOR || '';
    // m8: `DELEGATE_TERMINAL_GRACE_MS=0` must actually disable the grace-kill (some tests/hosts
    // want that) — `Number(env) || DEFAULT` treated 0 as falsy and silently fell back to the
    // 20s default instead of honoring an explicit 0.
    const graceEnv = process.env.DELEGATE_TERMINAL_GRACE_MS;
    const graceParsed = graceEnv !== undefined ? Number(graceEnv) : NaN;
    const graceMs = Number.isFinite(graceParsed) ? graceParsed : DEFAULT_TERMINAL_GRACE_MS;
    let terminalSeen = false;
    const armGrace = () => {
      graceTimer = setTimeout(() => {
        // Not a timeout/cancellation (that's `cancelled`/124 above) — the stream itself said it
        // was done; the OS process just never followed through and exited. Kill it and let
        // classifyFailure() judge success/failure from the events already captured, the same as
        // it would for any clean exit.
        gracedKill = true;
        mirror.write(`\x1b[33mWORKER STREAM COMPLETE but process did not exit within ${graceMs}ms — killing\x1b[0m\n`);
        killTree(child.pid);
      }, graceMs);
    };
    const noteTerminalEvent = line => {
      let event = null;
      try { event = JSON.parse(line); } catch { return; }
      if (terminalSeen) {
        // M1(b): any further parsed event arriving after the grace timer is armed means the
        // stream is still actively producing output — it isn't hung, so cancel and re-arm the
        // timer from here instead of killing on a schedule set by the first (possibly
        // mid-stream, not actually final) terminal-shaped event.
        if (graceMs <= 0) return; // disabled — nothing to re-arm
        if (graceTimer) clearTimeout(graceTimer);
        armGrace();
        return;
      }
      if (!isTerminalEvent(vendor, event)) return;
      terminalSeen = true;
      if (graceMs > 0) armGrace();
    };
    const renderer = new EventRenderer(vendor, { cwd: job.cwd, color: true });
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      fs.appendFileSync(eventsFile, chunk);
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) if (line.trim()) { renderedWrite(mirror, renderer.line(line)); noteTerminalEvent(line); }
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
      child.on('close', (status, signal) => resolve(
        cancelled ? 124 : (gracedKill ? 0 : (status == null ? (signal ? 143 : 1) : status))
      ));
    });
    // m7: no noteTerminalEvent() call here — the child has already closed (we're past the
    // `child.on('close', ...)` promise above), so arming a grace-kill timer against a process
    // that's already gone is dead code; only render whatever trailing partial line remains.
    if (pending.trim()) renderedWrite(mirror, renderer.line(pending));
    return code;
  } finally {
    if (cancelTimer) clearInterval(cancelTimer);
    if (graceTimer) clearTimeout(graceTimer);
    try { fs.unlinkSync(currentPidFile); } catch {}
  }
}

async function runConsole(directory, title, idleMinutes = 10, options = {}) {
  const queue = path.join(directory, 'queue');
  const done = path.join(directory, 'done');
  fs.mkdirSync(queue, { recursive: true });
  fs.mkdirSync(done, { recursive: true });
  const stop = path.join(directory, 'stop');
  const pidFile = path.join(directory, 'pid');
  // F3: refuse to start a second console for a window a live one already owns. This is a
  // best-effort guard here (the authoritative fix for the submitJob-side race is the O_EXCL
  // spawn.lock in submitJob); it mainly protects a console started directly (e.g. by hand, or
  // by a launcher that bypassed submitJob's lock).
  // B1: this refusal must only ever gate the *persistent* case (a real terminal window/console
  // reused across jobs). A one-shot inline console (`--once`, used by DELEGATE_NO_WINDOW=1 and
  // by submitJob's window-spawn-failed fallback) is expected to coexist with another console
  // already owning this directory — refusing it here made submitJob's own inline fallback throw
  // "inline console died before completing job" whenever any other console (including another
  // concurrent inline one) already held the pid file. spawnWindow never passes --once, so a real
  // persistent console is never affected by this gate.
  if (!options.once && alive(pidFile)) {
    const existing = Number(readFileOrNull(pidFile));
    if (existing !== process.pid) {
      console.log(`console already running for window '${title}' (pid ${existing}); exiting`);
      return;
    }
  }
  // m2: only consume the `stop` marker once we're actually past the refusal check — otherwise a
  // console that's about to refuse (another live console already owns this directory) would
  // swallow an orchestrator's pending close request for that live console before exiting itself.
  try { fs.unlinkSync(stop); } catch {}
  fs.writeFileSync(pidFile, String(process.pid));
  const removeSignalHandlers = installSignalHandlers(directory);
  // Heartbeat: touch `pid`'s mtime independent of the main loop's cadence, since a long-running
  // job keeps the loop parked on a single `await executeJob(...)` for as long as the job runs -
  // if the heartbeat only ticked between loop iterations, alive() would wrongly call this
  // console dead partway through any job longer than HEARTBEAT_STALE_MS.
  const heartbeat = setInterval(() => {
    const now = new Date();
    try { fs.utimesSync(pidFile, now, now); } catch {}
  }, 10000);
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
        try {
          fs.renameSync(path.join(queue, filename), jobFile);
        } catch (error) {
          // F2: another console racing on the same directory already claimed this job - not our
          // job to run, move on rather than crash (a crash here would fall through to the outer
          // finally and could delete a still-live sibling console's shared `pid` file — see the
          // ownership check there).
          // m1: only treat this as "someone else claimed it" (and move on) if the source file is
          // actually gone now — an ENOENT from some other cause (e.g. the `done` directory itself
          // vanishing) with the source still present must rethrow, or this would busy-spin
          // retrying the same still-queued job forever instead of surfacing the real error.
          if (error.code === 'ENOENT' && !fs.existsSync(path.join(queue, filename))) continue;
          throw error;
        }
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
    clearInterval(heartbeat);
    removeSignalHandlers();
    // F2: only unlink `pid` if it still names us — a sibling console that raced us onto the
    // same directory (or a newer console that has since taken over) may have overwritten it
    // with its own, still-live, pid. Deleting someone else's live pid file makes every waiting
    // submitJob see the window as dead and throw `console died`.
    try { if (fs.readFileSync(pidFile, 'utf8') === String(process.pid)) fs.unlinkSync(pidFile); } catch {}
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

async function submitJob(name, job, { timeoutMs } = {}) {
  const directory = consoleDir(name);
  const queue = path.join(directory, 'queue');
  fs.mkdirSync(queue, { recursive: true });
  const id = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const jobFile = path.join(queue, `${id}.job`);
  // job.id travels with the serialized job so executeJob (the actual consumer, possibly in a
  // different OS process — a persistent console window) knows which `<id>.cancel` marker is
  // its own to watch for.
  fs.writeFileSync(jobFile + '.tmp', `${JSON.stringify({ ...job, id })}\n`);
  fs.renameSync(jobFile + '.tmp', jobFile);
  const pidFile = path.join(directory, 'pid');
  let consoleChild = null;

  // F1: when submitJob runs an inline console (DELEGATE_NO_WINDOW=1, or the window-spawn
  // fallback below), that console runs as a foreground child sharing this process's group —
  // installSignalHandlers here is belt-and-suspenders alongside the one runConsole installs on
  // itself: it also covers a signal sent to submitJob's own pid specifically (not the group),
  // which would never reach the child otherwise.
  let removeSignalHandlers = null;
  const runInline = () => {
    const cli = path.join(packageRoot(), 'bin', 'cli.js');
    // M3: under DELEGATE_QUIET (tests) this child's stdio is never inherited — its raw/ANSI
    // console output must not land on this process's own stdout fd (see Mirror.write above).
    const stdio = process.env.DELEGATE_QUIET ? 'ignore' : 'inherit';
    consoleChild = spawn(process.execPath, [cli, '_console', directory, name, process.env.DELEGATE_IDLE_MIN || '10', '--once'], { stdio });
    removeSignalHandlers = installSignalHandlers(directory);
  };

  if (process.env.DELEGATE_NO_WINDOW === '1') {
    runInline();
    console.log(`window=${name} (inline)`);
  } else {
    if (fs.existsSync(path.join(directory, 'stop'))) {
      for (let i = 0; i < 30 && alive(pidFile); i++) await sleep(500);
    }
    if (!alive(pidFile)) {
      // F3: guard the check-pid → spawn-window window with an O_EXCL lock so two concurrent
      // submitJob calls for the same window can't both see "no live console" and both open one.
      let gotLock = acquireSpawnLock(directory);
      if (!gotLock) {
        // Someone else is (or just was) spawning the window — wait for its pid to appear
        // instead of racing it.
        for (let i = 0; i < 50 && !alive(pidFile); i++) await sleep(200);
        if (!alive(pidFile)) gotLock = acquireSpawnLock(directory); // stale lock or the other spawn failed; try to take over
      }
      if (alive(pidFile)) {
        // Known limitation (F14, and its narrow F3 cousin): a pid we're "reusing" here could be
        // either a persistent window (the common case — always shareable) or another caller's
        // one-shot `--once` inline fallback (spawned a few lines below when a real terminal
        // couldn't be opened at all, e.g. a headless host) — which serves exactly one job and
        // then exits. If that happens to be what we're reusing and it exits before claiming our
        // job, the wait loop below throws a clear `console died` rather than silently hanging;
        // we don't attempt to self-heal by re-spawning, matching how any other console crash
        // mid-job is already surfaced. Two consoles sharing one on-disk queue directory (this
        // case vs. a genuinely separate inline invocation, e.g. DELEGATE_NO_WINDOW plus a window
        // console for the same name) is a pre-existing design limitation, not something this fix
        // set out to solve.
        console.log(`window=${name} (reused)`);
      } else if (gotLock) {
        try {
          try { fs.unlinkSync(pidFile); } catch {}
          try { fs.unlinkSync(path.join(directory, 'stop')); } catch {}
          const started = await spawnWindow(directory, name, Number(process.env.DELEGATE_IDLE_MIN || 10));
          if (started) for (let i = 0; i < 50 && !alive(pidFile); i++) await sleep(200);
          if (!alive(pidFile)) {
            console.error('console window failed to start; running inline');
            runInline();
          } else console.log(`window=${name} (opened)`);
        } finally {
          releaseSpawnLock(directory);
        }
      } else {
        // Couldn't get the lock and no pid ever appeared (rare) — don't spin forever, run inline.
        console.error('console window failed to start; running inline');
        runInline();
      }
    } else console.log(`window=${name} (reused)`);
  }

  try {
    const exitFile = path.join(queue, `${id}.exit`);
    const cancelFile = path.join(queue, `${id}.cancel`);
    const startedFile = path.join(queue, `${id}.started`);
    let childEnded = false;
    if (consoleChild) {
      consoleChild.once('error', () => { childEnded = true; });
      consoleChild.once('close', () => { childEnded = true; });
    }
    // The timeout clock starts when the consumer actually begins running this job (stamped by
    // executeJob into `${id}.started`), not at submission — a job sitting queued behind another
    // must get its full timeoutMs once it starts, not be judged against how long it waited.
    let deadline = null;
    let cancelSent = false;
    while (!fs.existsSync(exitFile)) {
      await sleep(250);
      if (deadline == null && timeoutMs != null) {
        const startedAt = readStartedAt(startedFile);
        if (startedAt != null) deadline = startedAt + timeoutMs;
      }
      if (!cancelSent && deadline != null && Date.now() >= deadline) {
        cancelSent = true;
        // Never leave the console wedged: the consumer (executeJob, possibly a different OS
        // process — a persistent window) polls for this file and kills the hung child itself.
        try { fs.writeFileSync(cancelFile, ''); } catch {}
      }
      if (!fs.existsSync(exitFile) && childEnded) throw new Error('inline console died before completing job');
      if (!consoleChild && !alive(pidFile)) throw new Error('console died');
    }
    const code = Number(fs.readFileSync(exitFile, 'utf8'));
    fs.unlinkSync(exitFile);
    // Backstop cleanup: a cancel sent right as the job finished on its own (a near-deadline race)
    // may never get consumed by executeJob's watcher — never leave either marker as an orphan.
    try { fs.unlinkSync(cancelFile); } catch {}
    try { fs.unlinkSync(startedFile); } catch {}
    if (consoleChild && consoleChild.exitCode == null) await new Promise(resolve => consoleChild.on('close', resolve));
    return code;
  } finally {
    if (removeSignalHandlers) removeSignalHandlers();
  }
}

async function interrupt(name) {
  const directory = consoleDir(name);
  const current = path.join(directory, 'current.pid');
  const info = fs.existsSync(current) ? readCurrentPid(current) : null;
  if (!info) {
    console.log(`no job running in window ${name}`);
  } else if (!verifyProcessOwnership(info)) {
    // F4: current.pid can go stale (job already finished and its pid reused by an unrelated
    // process) before an operator gets around to running `interrupt` — never kill blind.
    console.error(`refusing to interrupt window ${name}: pid ${info.pid} no longer looks like the recorded worker (stale or reused pid)`);
  } else {
    const pid = info.pid;
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

module.exports = {
  close, consoleDir, consoleRoot, executeJob, interrupt, runConsole, submitJob,
  // Exported for testability only (see test/console.test.js) — not part of the public CLI surface.
  acquireSpawnLock, releaseSpawnLock, readStartedAt
};

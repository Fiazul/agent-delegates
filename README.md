# agent-delegates

Run Codex, Antigravity, Grok Build, and Claude Code workers in reusable terminal
windows. Give a worker a brief, follow up in the same conversation, and collect
its report and execution artifacts.

## Install

Requires Node.js 18+, npm, Git for GitHub installation, and authenticated vendor
CLIs on PATH for the vendors you use. No runtime npm dependencies, Python, jq,
or build step are required.

```sh
npx github:Fiazul/agent-delegates install --statusline
```

This links five skills into both ~/.claude/skills and ~/.agents/skills.
Existing non-link directories are backed up as <name>.bak-<timestamp>.
The links target npm's cached checkout; rerun install if that cache is removed.
For a durable global CLI installation:

```sh
npm install -g github:Fiazul/agent-delegates
agent-delegates install --statusline
```

Without a global installation, replace agent-delegates in the examples with
`npx github:Fiazul/agent-delegates`. Reinstall to update. Remove installed links
with `agent-delegates install --uninstall`; backups are retained.

On POSIX, existing .bashrc and .zshrc files receive a delegates status alias.
Windows skips shell aliases, attempts directory junctions, and copies the skill
directories with a printed note if junctions fail. Copies need reinstalling
after package updates.

### Claude statusline

--statusline copies a standalone Node helper to ~/.claude and configures
settings.json with a command of the form:

```text
node "/absolute/path/.claude/agent-delegates-statusline.js"
```

The same command works on Windows without Bash or PowerShell scripts. It writes
~/.claude/rate_limits.json from Claude's stdin snapshot, then invokes any previous
configured statusline command with the same input. Otherwise it shows a minimal
quota line. Uninstall leaves this independent helper and settings in place.

## Commands

```sh
agent-delegates status
agent-delegates run codex luna BRIEF.md --cd "/path with spaces/repo"
agent-delegates resume codex THREAD_ID FOLLOWUP.md --cd "/path with spaces/repo"
agent-delegates interrupt codex
agent-delegates close codex
agent-delegates --help
```

Vendors are codex, agy (alias antigravity), grok, and claude. Use --name N on
run/resume for a named window, then interrupt N or close N. A brief filename
of - reads stdin. Always repeat --cd on resume.

| Skill | Tiers |
|---|---|
| delegate-codex | luna, terra, sol, astra |
| delegate-antigravity | lite, flash, pro, sonnet, opus |
| delegate-grok | fast, best |
| delegate-claude | haiku, sonnet, opus |
| delegates | Remaining quota and models for all four vendors |

The skill documents list model mappings and orchestration guidance.
Run options include --cd DIR, --name N, --effort E, and --add-dir D.
Codex uses workspace-write or --ro, with an auth-only ~/.codex-fresh home;
--full uses the configured home and must be repeated on resume. Codex never
uses the sandbox-bypass flag.

Antigravity defaults to --dangerously-skip-permissions because headless shell
permission requests otherwise fail; --safe selects accept-edits. Grok's --yolo
selects --always-approve. Claude defaults to acceptEdits; --yolo enables
--dangerously-skip-permissions. Scope briefs to the intended files and operations.

Status shows CLI, LEFT, and MODELS columns. Claude needs a statusline snapshot;
Codex uses its local authentication to query ChatGPT usage; agy uses /usage and
models; Grok uses models and its last-402 marker. --probe-grok makes a tiny paid
call to refresh Grok's status. Credentials and email addresses are not displayed.

## Windows and logs

Linux tries gnome-terminal, x-terminal-emulator, konsole, xterm, then tmux.
macOS opens Terminal.app through osascript. Windows tries Windows Terminal
(wt.exe), then a cmd window. These macOS and Windows integrations need native
platform validation.

One console per vendor/name shows the brief, model, narrative, tool activity,
and final result. It stays open for reuse and closes after 10 idle minutes.
Interrupt kills the worker process tree; close waits for active work.

| Environment variable | Purpose |
|---|---|
| DELEGATE_OUT | Job artifact root; defaults to the system temp directory/codex-workers |
| CODEX_WORKER_OUT | Legacy fallback when DELEGATE_OUT is unset |
| DELEGATE_NO_WINDOW=1 | Execute through the queue inline |
| DELEGATE_IDLE_MIN | Idle-close minutes, default 10 |
| DELEGATE_CONSOLE_DIR | Override console queue/log root |

Console logs live at ~/.cache/delegates/<name>/console.log on POSIX and
%LOCALAPPDATA%/delegates/<name>/console.log on Windows. Each output directory
contains brief.md, prompt.md, events.jsonl, last.md, exit, stderr.log, and
thread_id (Codex), conversation_id (agy), or session_id (Grok/Claude).
The caller receives out=, exit=, the ID, usage=, open=, and the final report.
Treat briefs and worker transcripts as private project data.

## Development

```sh
npm test
node bin/cli.js --help
npm pack --dry-run
```

The optional extras/claude-routing-rule.md contains routing guidance.

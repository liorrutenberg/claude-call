# claude-call — Cleanup & Improvements

## 2. TUI sidebar
- Voice activity + bg agent status panel alongside claude
- Start simple: `claude-call monitor` that tails channel.log with formatted output
- Future: split-pane with ink/React showing dispatches, results, voice state

## 3. Voice tools restriction
- Voice session should ONLY dispatch background agents (`run_in_background: true`)
- No direct tool use (Read, Write, Bash, Edit) — keeps voice loop responsive
- Prompt change in `src/cli.ts` call session prompt

## 4. Uninstall command
- `claude-call uninstall` that removes:
  - `~/.claude-call/` (config, models, logs, runs, bin)
  - `~/.claude/commands/call-*.md` (skills)
  - PATH entry from `.zshrc`
  - Optionally: brew packages (sox, whisper-cpp, piper)
- Must confirm before deleting

## 5. Setup split (install vs init)
- `claude-call install` — global, once (deps, models, skills, bin scripts)
- `claude-call init` — per-project (`.mcp.json` entry, display server config)
- First run of `setup` does both; subsequent projects only need `init`
- Clarify installer flow for new users vs existing users adding to new project

## 6. Clean exo from claude-call legacy
- Audit exo repo for stale call-related files:
  - Old docs (`docs/research/call-session-architecture.md`?)
  - Stale data files, old configs
  - `.claude/` leftovers from previous call iterations
- Clean up old brew-installed models/binaries from earlier iterations
- Verify clean `claude-call setup` works from scratch after cleanup

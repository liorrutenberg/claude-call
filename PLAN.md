# claude-call — Cleanup & Improvements Plan

## Approach

3 waves, each containing parallel subtasks where possible. After each subtask: self-review + ask-codex review before merge. Keep it simple — no over-engineering, no speculative abstractions.

---

## Wave 1: Hardening (parallel)

### 1A. Voice tools restriction
**Goal:** Voice session should dispatch background agents for real work. Quick lookups OK inline.

**What:**
- Update `buildCallSessionPrompt()` in `src/cli.ts` to add tool guidance
- Rule: "For anything beyond a single quick file read, dispatch a background agent. You may use Read for trivial lookups (checking a single file). For multi-step work, searching, writing, or bash commands — always use Agent with `run_in_background: true`."
- This keeps the voice loop responsive while not forcing agent overhead for 2-line reads
- **Note:** Soft enforcement (prompt-only). Good enough for now — restrict at MCP level if needed later.

**Files:** `src/cli.ts`
**Review:** ask-codex on the prompt diff

### 1B. Stale session cleanup (launcher hardening)
**Goal:** `eld`/`eldc`/`eldr` scripts reliably clean up on any exit.

**What:**
- Test: kill -9 the claude process, verify voice stops
- Test: Ctrl+C, verify clean shutdown
- No watchdog — stale lock detection in runtime.ts already handles orphaned sessions
- Document kill -9 as known limitation: "run `claude-call call stop` manually"
- Update README with known limitations

**Files:** `bin/eld`, `bin/eldc`, `bin/eldr`, README.md
**Review:** manual testing + ask-codex on any new code

---

## Wave 2: Install/Uninstall (parallel)

### 2A. Uninstall command
**Goal:** `claude-call uninstall` that cleanly removes everything.

**What:**
- Add `uninstall` command to `src/cli.ts`
- **Check for active sessions first** — refuse to uninstall if a call session is running
- **Kill lingering whisper-server** on port 8178 if running
- **Clean orphaned run dirs** under `~/.claude-call/runs/`
- Removes:
  - `~/.claude-call/` (config, models, logs, runs, bin)
  - `~/.claude/commands/call-*.md` (skills)
  - Optionally: brew packages (sox, whisper-cpp, piper) — ask user
- **PATH removal:** Don't regex-edit .zshrc/.bashrc — too risky. Print the line to remove and tell the user to do it manually.
- **`--dry-run` flag:** Show what would be deleted without deleting. Cheap to implement, high trust.
- Must confirm before deleting (interactive Y/n)
- Show what will be deleted before asking

**Files:** `src/cli.ts` (new command handler)
**Review:** ask-codex on safety — are we deleting the right things? Missing anything?

### 2B. Setup split (install vs init)
**Goal:** Separate global setup from per-project init. No legacy compat.

**What:**
- **Remove `setup` command entirely.** Replace with:
- `claude-call install` — global, once: deps, models, skills, bin scripts, PATH, pronunciation config
- `claude-call init` — per-project: `.mcp.json` entry, display server config
- No backward compat. Clean two-command flow.
- `init` **fails if `install` hasn't run** — check for `~/.claude-call/config.yaml`, error with "Run `claude-call install` first."
- `init` detects and wires up user pronunciation file from `~/.claude-call/pronunciation.yaml` if it exists
- Update README with the two-command flow

**Files:** `src/cli.ts` (refactor setup into install + init), README.md
**Review:** ask-codex on the UX flow — is it clear for new users?

---

## Wave 3: TUI + Docs

### 3A. Agent tracking design (prerequisite for monitor)
**Goal:** Define how the monitor knows about agent dispatches and completions.

**Problem:** The monitor needs to show agent status, but the voice session (headless Claude) dispatches agents internally — we have no hook into dispatch/completion events. The display server sees POST results (completions) but not dispatch events.

**Options:**
1. **Structured display POST** — Add agent metadata (id, name, status, timing) to the curl payload in the call prompt. Display server logs to `agents.json` in run dir.
2. **Prompt-driven file writes** — Call prompt tells Claude to write agent dispatch/completion to a file in the run dir before/after each agent call.
3. **Parse display server traffic** — Infer agent activity from POSTs hitting :9847.

**Decision:** Option 1 (structured POST) — cleanest, one mechanism for both display and tracking.

**What:**
- Update call session prompt to include agent metadata in display curl body
- Update display server to parse metadata and append to **JSONL** file in run dir (not JSON — append-only, no race conditions)
- Event format: `{"event":"dispatch","name":"sync","ts":"..."}` / `{"event":"complete","name":"sync","ts":"...","summary":"..."}`
- Use `name + timestamp` as composite key (Claude-generated IDs won't be consistent)
- **Handle malformed/missing metadata gracefully** — don't crash or lose display text if fields are absent. Best-effort dispatch tracking; infer "running" from no completion within time window.

**Files:** `src/cli.ts` (prompt), `src/display-server.ts` (agent tracking)
**Review:** ask-codex on the tracking design

### 3B. TUI monitor (Ink)
**Goal:** `claude-call monitor` — interactive status panel alongside claude.

**Design:**

```
┌─────────────────────────────────────────────────────────────────────┐
│ CLAUDE CODE (main session)            │ claude-call monitor        │
│                                       │                            │
│ $ eld                                 │ VOICE: listening           │
│ Voice call started.                   │   last: "run sync" (3s)   │
│                                       │                            │
│ > What's in the auth module?          │ ── AGENTS ──               │
│                                       │ > sync        done  12s   │
│ Checking the auth module...           │   trace-check  running 4s │
│                                       │   mo-plan      queued     │
│ [agent output displayed here]         │                            │
│                                       │ ── SESSION ──              │
│                                       │   uptime: 14m             │
│                                       │   agents: 3 (1 active)    │
│                                       │   project: exo            │
│                                       │                            │
└─────────────────────────────────────────────────────────────────────┘
```

**Implementation (Ink):**
- All TUI code isolated in `src/tui/` — will evolve independently
- Use Ink (React for CLI) — supports interactive selection, live updates, component model
- **Separate `tsconfig.tui.json`** extending base, adding `jsx: "react-jsx"`. Build: `tsc -p tsconfig.json && tsc -p tsconfig.tui.json`
- `src/tui/App.tsx` — main component, polls run dir state
- `src/tui/VoiceStatus.tsx` — voice state from status.json
- `src/tui/AgentList.tsx` — reads agents.json, shows status, selectable to view output
- `src/tui/SessionInfo.tsx` — uptime, counts, project
- Phase 1: read-only status + select agent to view output
- Phase 2 (future): interact with agents, send input to voice session

**Launcher integration:**
- `eld --monitor` flag creates a tmux split-pane automatically (~10 lines of shell)
- Without flag, user can run `claude-call monitor` in a separate terminal/tmux pane

**Files:** `src/cli.ts` (command), `src/tui/*` (new), `bin/eld*` (--monitor flag), `package.json` (ink dep)
**Review:** ask-codex on the TUI design + code

### 3C. README + docs refresh (after 3A + 3B)
**Goal:** Keep README and docs current with all changes from waves 1-3.

**What:**
- Update README with: uninstall command, install/init flow, monitor command, --monitor flag
- Update CLAUDE.md if any prompt/behavior changes
- Ensure setup output messages match actual commands

**Files:** `README.md`, possibly `CLAUDE.md`
**Review:** ask-codex on docs clarity

---

## Done: Exo Legacy Cleanup (completed)

Cleaned before starting waves:
- Removed `.subtask/tasks/{build--claude-call, poc--call-session, update--claude-call-v2, streaming-stt}/`
- Removed `call-artifacts/`, `.claude-call/artifacts/hello.md`
- Removed `docs/research/call-session-architecture.md`
- Removed `.venv/` + `.venv-tts/` (1.3GB freed)
- Moved `data/integrations/voice/pronunciation.yaml` → `~/.claude-call/pronunciation.yaml`

---

## Review Protocol

For each subtask:
1. Implement on `feat/cleanup-and-improvements` branch
2. Self-review: check for dead code, missing edge cases, docs
3. ask-codex review: `claude -p "Review this diff for [subtask]. Check for: missing edge cases, dead code, security issues, docs gaps. Be critical." --permission-mode read < diff`
4. Address feedback
5. Commit with clear message

Final: ask-codex review of complete wave before merging to main.

---

## Principles

- **Simple first.** No abstraction until we have 3 uses.
- **Working > perfect.** Each subtask ships something usable.
- **Open source quality.** README, help text, and error messages should make sense to someone who's never seen the project.
- **No speculative features.** Build what's needed now. Phase 2 lives in comments, not code.
- **Isolate evolving code.** TUI in `src/tui/`, agent tracking in display server — clean boundaries for future iteration.

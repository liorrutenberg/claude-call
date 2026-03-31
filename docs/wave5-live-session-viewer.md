# Wave 5: Live Session Viewer

## Goal

See all Claude sessions (voice + subagents) live in the TUI monitor, with scrollable output and ability to send follow-up messages.

## Architecture (revised after codex review)

**Key insight:** `stdout.log` already captures the full JSON stream for the voice session. No need for hook-based log files. Use one `SubagentStart` hook for metadata only (session ID mapping), and parse `stdout.log` for all content.

```
stdout.log (voice session — already exists)
    ├── init → real Claude session_id
    ├── assistant messages (text, tool_use, thinking)
    ├── user messages (tool_result)
    └── subagent events visible as Agent tool calls

SubagentStart hook → sessions.jsonl (metadata only)
    └── {claude_session_id, agent_id, agent_type, ts}

TUI reads both:
    ├── stdout.log → voice session content (live tail)
    ├── sessions.jsonl → maps subagent IDs to types
    └── agents.jsonl → existing dispatch/complete tracking
```

## Steps

### Step 1: Parse stdout.log for voice session viewer
- New `src/tui/SessionLog.tsx` component
- Reads `stdout.log` from run dir, parses JSONL
- Extracts: assistant text, tool calls (name + summary), tool results
- Renders as scrollable log with up/down keys
- Auto-scrolls to bottom unless user scrolled up
- Shows voice session as first entry in session list

### Step 2: Extract real Claude session ID
- Parse `stdout.log` first line (`type: "system", subtype: "init"`) for `session_id`
- Store in state alongside existing status info
- This is the resumable session ID (not our internal UUID)

### Step 3: SubagentStart hook for metadata
- Create `hooks/agent-register.sh`
- Gated by `CLAUDE_CALL_RUN_DIR` env var — exits immediately if not set
- Reads JSON stdin: `session_id`, `agent_id`, `agent_type`
- Appends to `$CLAUDE_CALL_RUN_DIR/sessions.jsonl`
- Register in user's `~/.claude/settings.json` (via install command)

### Step 4: Unified session list in TUI
- Update `state.ts` to read `sessions.jsonl` + merge with `agents.jsonl`
- Voice = always first, identified by stdout.log init session_id
- Subagents = matched by agent_type to agent name from agents.jsonl
- Each row: name, status, elapsed, last line preview

### Step 5: Message input for finished sessions
- Press `i` on a finished agent to enter input mode
- Text input at bottom of log viewer
- Enter → `claude --resume <claude_session_id> -p "message"` in background
- Esc exits input mode

### Deferred (Wave 6)
- Kill + resume for running agents (needs PID tracking)
- Subagent stdout capture (subagents don't write to our stdout.log)
- Run dir retention after `call stop`

## Files

### New:
- `hooks/agent-register.sh` — SubagentStart hook
- `src/tui/SessionLog.tsx` — Scrollable log viewer

### Modified:
- `src/tui/App.tsx` — Wire session list, log viewer, input mode
- `src/tui/state.ts` — Parse stdout.log, read sessions.jsonl
- `src/tui/types.ts` — Add session types
- `src/tui/AgentList.tsx` → rename to `SessionList.tsx` (voice + agents)

## Notes from codex review
- Hooks MUST be gated by `CLAUDE_CALL_RUN_DIR` — prevents non-call sessions from writing
- `status.json.sessionId` is our internal UUID, NOT Claude's resumable ID — use stdout.log init
- Don't duplicate state — one metadata file (sessions.jsonl), reuse stdout.log for content
- Stop hook too slow for live view — stdout.log is already live

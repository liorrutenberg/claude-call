# Call Session v2: Dual Session Voice Architecture

## Problem

Voice and text share a single session. Voice processing blocks the terminal. Background noise queues as messages. User can't type while voice is handled.

## Solution

Two independent Claude sessions:
- **Main session** (interactive terminal): No voice MCP. Typing only. `/call-start` spawns the call session, `/call-stop` kills it.
- **Call session** (headless `claude -p`): Owns the mic via voice MCP. Converses via speak. Delegates heavy work to background agents. Pushes output to workspace when asked.

## Proven by POC (2026-03-27)

- Headless `claude -p --input-format stream-json` stays alive across turns via FIFO
- Voice MCP connects, captures mic, transcribes, speaks — all working
- Real-time voice conversation while main terminal stays free
- Stream-json format: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`
- Channel notifications do NOT trigger new turns in `-p` mode — delivery must go through FIFO

## Architecture

```
┌─────────────────────────────────┐
│  MAIN SESSION (interactive)     │
│  No voice MCP loaded            │
│  /call-start → spawns call      │
│  /call-stop  → kills call       │
│  /call-status → health check    │
│  Terminal stays 100% free       │
│  Reads events from .claude-call/  │
│  events.jsonl when pushed         │
└────────────┬─────────────────────┘
             │ .claude-call/ (shared workspace)
┌────────────┴────────────────────┐
│  CALL SESSION (headless)        │
│  claude -p + stream-json + FIFO │
│  Voice MCP (sole mic owner)     │
│  deliver() writes directly to   │
│  FIFO (no relay watcher)        │
│  Loads call-session prompt      │
│  Can read main session context  │
│  Writes event pointers          │
└─────────────────────────────────┘
```

## Design Decisions

### 1. Direct FIFO delivery (no relay)

`deliver()` in channel.ts detects call mode and writes stream-json directly to the FIFO instead of using MCP channel notifications. Zero added latency, no brittle log-tailing middle process.

### 2. Per-run isolation

Each call session gets a runtime directory: `~/.claude-call/runs/<project-hash>/`
Contains: lock file, status file, FIFO, MCP config, session-scoped pause/stop files.

Global `/tmp/claude-call-stop` and `/tmp/claude-call-pause` move here to prevent cross-session collisions.

### 3. Voice MCP only in call session

Main session never loads voice MCP. A per-run MCP config is generated and passed only to the headless call process. The main session's `.mcp.json` does not include voice in dual mode.

### 4. Shared workspace at `.claude-call/`

```
.claude-call/
└── events.jsonl      # Event pointers from call session (processed by main)
```

Call session speaks summaries. When user says "show it" or "put it on screen", call writes an event pointer to `events.jsonl`. The main session's watcher picks it up, fetches the full message from the session log, and displays it.

### 5. Audio feedback cues

Three sounds, separate from TTS playback:
- **Start/resume chime**: When call session activates or unpauses
- **Pause chime**: When call pauses
- **Thinking pulse**: Starts after 500ms of silence from Claude (user spoke, waiting for response). Stops when response begins. Tells user "I'm working on it."

No ambient idle sound. Silence = ready to listen.

### 6. Call session behavior (prompt)

The call session loads a dedicated prompt that defines its personality and rules:

**Core behavior — never go silent:**
1. User speaks → call session **immediately acks** ("Got it", "On it", "One sec")
2. Dispatches work to background agent (always `run_in_background: true`)
3. **Stays available** — user can keep talking while agents work
4. When agent completes → speaks result naturally ("Done — here's what I found", "Want me to show the full report?")

**Shared screen model:**
- Main terminal = shared screen. Call session references it naturally.
- "I'll put that on screen" → writes event pointer, main session displays it
- "Check the main session" → reads main session conversation JSON
- Heavy output goes to event pointers, summaries go to voice

**Delegation rules:**
- Anything that takes >2s thinking → background agent
- Memory searches, trace lookups, calendar checks, file reads, multi-step research → all agents
- Only answer from immediate context or profile knowledge directly
- Never make the user wait. Ack first, work second.

**Voice style:**
- Concise spoken answers, no markdown, no bullet points
- Conversational, not robotic
- "Got it, running sync now" not "I will now execute the sync command"
- Natural transitions: "By the way...", "Oh, one thing...", "Before I forget..."

### 7. Crash handling

- `call start` supervises the headless process
- One-shot restart on startup crash only
- After that: mark `crashed` in status.json, stop
- No infinite restart loops

### 8. Launch experience

Default `claude` does NOT start call mode. Voice activates only via:
- `/call-start` from an active Claude Code session
- Or a CLI flag (future: `claude --voice`)

## Task Breakdown

| # | Task | Files | What |
|---|------|-------|------|
| 1 | Runtime state & locking | new `src/runtime.ts`, `src/config.ts`, `src/voice/recorder.ts` | Per-run dir, lock file, status file, session-scoped stop/pause files, FIFO paths |
| 2 | CLI `call start/stop/status` | `src/cli.ts` | Spawn headless session, per-run MCP config, cleanup on stop, health output |
| 3 | Remove voice from main session | `src/cli.ts`, `plugin.json`, docs | Dual-mode setup: voice MCP only loads in call process |
| 4 | Direct FIFO delivery | `src/channel.ts`, `src/voice/recorder.ts` | `deliver()` writes stream-json to FIFO in call mode; channel notifications for legacy single-session |
| 5 | Shared workspace | new `src/workspace.ts`, `src/cli.ts` | `.claude-call/` dir, event pointers |
| 6 | Call session prompt | new `prompts/call-session.md`, `src/cli.ts` | Voice-first behavior, ack-first-delegate-second, shared-screen model, event pointer rules |
| 7 | Audio cue management | new `src/voice/feedback.ts`, `src/voice/tts.ts`, `src/channel.ts`, `src/config.ts` | Separate cue playback from TTS, start/pause/thinking sounds |
| 8 | Crash supervision & cleanup | `src/cli.ts`, `src/channel.ts`, `src/voice/recorder.ts` | Heartbeat, broken-pipe handling, targeted process kill (only owned children) |
| 9 | Latency measurement | `src/channel.ts`, `src/cli.ts` | Timestamp pipeline stages, log end-to-end numbers |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Global temp files collide across sessions | Move to per-run dir (task 1) |
| `killStaleRecProcesses()` kills unrelated `rec` | Kill only owned child PIDs (task 8) |
| FIFO writes block if claude exits | Broken-pipe handling + timeout (task 8) |
| Audio cues clobber TTS playback slot | Separate playback channel for cues (task 7) |
| Duplicate `/call-start` races | Atomic lock file (task 1) |
| Main session accidentally loads voice | Per-run MCP config, voice only in call process (task 3) |

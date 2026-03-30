# Architecture

## Overview

claude-call is an MCP channel server that provides continuous two-way voice I/O for Claude Code. It runs as a subprocess spawned by Claude Code, communicating over stdio using the MCP protocol.

## Delivery Modes

claude-call supports two delivery modes depending on the session type:

### Dual-session mode (default)
Voice is delivered directly to the headless call session via FIFO using stream-json format. The call session runs as `claude -p` with stdin connected to a named pipe. Transcribed speech is written as `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}` to the FIFO.

### Single-session mode (legacy)
Voice is delivered via MCP channel notifications (`notifications/claude/channel`). Claude sees voice input as `<channel source="voice">` tags alongside typed input.

In both modes, Claude calls the `speak` tool exposed by the MCP server for TTS output.

## Voice Loop

The main loop in `channel.ts` runs continuously:

```
┌─→ Check muted? ──→ waitForUnmute() ──→ ↑
│
│   Record utterance (sox + VAD)
│   │  ├─ VAD detects speech start → begin preview timer
│   │  ├─ Every 600ms → extract rolling window → fast transcribe → log
│   │  └─ VAD detects silence (1-2.5s) → stop recording
│   │
│   ↓
│   Final transcription (Whisper, beam search + domain prompt)
│   │
│   Filter junk transcripts ("thank you", "thanks for watching", etc.)
│   │
│   Deliver via channel notification → Claude processes
│   │
└───┘
```

## Echo Suppression

When Claude speaks (via the `speak` tool), the voice loop must not record the TTS output as new speech. This is handled via a `muted` flag:

1. `speak` handler calls `ttsSpeak()` with `onMute` callback
2. `onMute` sets `muted = true` and calls `triggerStop()` (kills any in-flight recording)
3. Voice loop checks `muted` at multiple points — skips recording if true
4. `onUnmute` (after TTS finishes + 300ms buffer) sets `muted = false`

## Keyword Interrupt

During TTS playback, a separate background mic monitors for interrupt keywords:

1. `startKeywordMonitor()` spawns a new `rec` process
2. Audio chunks are fed through VAD continuously
3. When a speech burst is detected (3+ consecutive speech chunks), a rolling window of audio is extracted as WAV
4. The WAV is fast-transcribed (no beam search) and checked against keywords
5. If a keyword matches, `stopSpeaking()` kills the `afplay` process mid-sentence

This is more reliable than a simple mute toggle because Whisper transcribes TTS echo as the TTS text (no keyword match), while the user saying "stop" produces a match.

## Silero VAD

Voice Activity Detection uses the Silero VAD v5 ONNX model:

- **Chunk size**: 512 samples (32ms at 16 kHz)
- **Context**: 64-sample window prepended to each chunk
- **Threshold**: 0.3 probability for speech detection
- **Model size**: ~2.3 MB
- **Performance**: <1% CPU on Apple Silicon

The ONNX model is loaded via `onnxruntime-node` (native C++ addon, loaded via `createRequire`).

## Whisper STT

Two-tier architecture:

1. **Server mode** — HTTP POST to a running whisper-server. Model stays loaded in memory. ~100-300ms latency.
2. **CLI mode** — Spawn `whisper-cli` as subprocess. Model loads each time. ~1100ms latency.

Two quality modes:
- **`transcribe()`**: Accurate. Beam search (size 5), domain vocabulary prompt from pronunciation dictionary.
- **`transcribeFast()`**: Speed-first. No beam search, no prompt. Used for streaming previews and keyword detection.

## TTS Cascade

Three-tier cascade with sentence-level pipelining:

```
Text → Pronunciation rewrite → Split into sentences → Pipeline:
  ┌──────────────────────────────┐
  │ Synthesize sentence 1        │
  │            ↓                 │
  │ Play sentence 1 ──┐         │
  │                    │ Synthesize sentence 2
  │                    ↓         │
  │            Play sentence 2 ──┐
  │                              │ Synthesize sentence 3
  │                              ↓
  │                     Play sentence 3
  └──────────────────────────────┘
```

This pipelining means the user hears audio faster — the next sentence is being synthesized while the current one plays.

Engines tried in order (in `auto` mode):
1. **Piper** — Local ONNX inference, ~100ms
2. **edge-tts** — Microsoft Edge neural TTS, free
3. **macOS say** — Always-available fallback

## Recording

Sox `rec` is used for mic input. Key details:

- **Native rate detection**: Probes the default input device's sample rate to avoid resampling artifacts
- **Resampling**: If native rate differs from 16 kHz, linear interpolation downsamples in-process
- **WAV creation**: Raw PCM is wrapped in a WAV header (44 bytes) for Whisper compatibility
- **Signal files**: Per-run `stop` and `mute` files in `~/.claude-call/runs/<project-hash>/` for cross-process coordination

## Data Flow

### Voice Input (mic → call session)

```
Microphone
    │
    ↓
sox rec (native rate, 16-bit mono PCM)
    │
    ↓ (resample if needed)
    │
Silero VAD (512-sample chunks)
    │
    ├─ No speech for 15s → timeout, loop again
    ├─ Speech detected → start preview timer
    │   ├─ Every 600ms → rolling window → transcribeFast → log partial
    │   └─ Silence for 1-2.5s → utterance complete
    │
    ↓
Whisper STT (full utterance, beam search)
    │
    ↓
Junk filter (removes hallucinations like "thank you")
    │
    ↓
Deliver to call session via FIFO (stream-json format)
```

### Display Output (call session → main session)

```
Call session dispatches background agent
    │
    ↓
Agent completes work, formats result
    │
    ↓
HTTP POST to localhost:9847/display (JSON body with text field)
    │
    ↓
display-server.ts receives POST
    │
    ↓
MCP channel notification → notifications/claude/channel
    │
    ↓
Main session receives <channel source="call-display">content</channel>
    │
    ↓
Displayed to user in terminal
```

## Dual-Session Mode

claude-call uses a dual-session architecture to keep voice isolated from the main terminal:

```
┌─────────────────────────────────┐
│  MAIN SESSION (interactive)     │
│  No voice MCP loaded            │
│  /call-start → spawns call      │
│  /call-stop  → kills call       │
│  Terminal stays free for typing  │
│  call-display MCP (channel push) │
└────────────┬─────────────────────┘
             │ HTTP localhost:9847 (display push)
┌────────────┴────────────────────┐
│  CALL SESSION (headless)        │
│  claude -p + stream-json + FIFO │
│  Voice MCP (sole mic owner)     │
│  Agents curl display endpoint   │
│  to push output to main session │
└─────────────────────────────────┘
```

### Why Two Sessions?

In single-session mode, voice processing blocks the terminal. Background noise queues as messages. You can't type while voice is being handled.

Dual-session mode solves this:
- **Main session**: Pure text. `/call-start` spawns the voice session, `/call-stop` kills it. Loads `call-display` MCP for receiving pushed output.
- **Call session**: Headless `claude -p` process that owns the mic via voice MCP. Converses via speak tool. Background agents push output to the main session via HTTP.

### Two Delivery Mechanisms

Two different "channel" mechanisms coexist by design:

1. **Voice delivery (FIFO)**: `channel.ts` wraps transcriptions in stream-json format and writes directly to the FIFO → headless call session stdin. This is not MCP — it's direct pipe I/O.
2. **Display delivery (MCP channel)**: `display-server.ts` is an MCP channel server loaded by the main session. It listens on `localhost:9847`. When call session agents POST formatted output to it, it forwards via `notifications/claude/channel` to the main session, which sees `<channel source="call-display">content</channel>`.

These target different sessions (call vs main) via different mechanisms. Both use "channel" in their naming but are architecturally distinct.

### Voice Isolation

The voice MCP server is never loaded in the main session. Instead:
1. `claude-call install` installs deps, downloads models, and creates `/call-start` and `/call-stop` commands. `claude-call init` adds `call-display` MCP to the project `.mcp.json`.
2. `/call-start` runs `claude-call call start`, which spawns a headless claude with a per-run MCP config
3. The per-run MCP config includes only the voice server
4. The main session's `.mcp.json` includes `call-display` (display push) but not voice

The main session must be started with `--dangerously-load-development-channels server:call-display` to enable channel notifications from the display server.

This prevents accidental voice activation in the main terminal and eliminates resource contention between sessions.

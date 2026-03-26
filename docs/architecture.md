# Architecture

## Overview

claude-call is an MCP channel server that provides continuous two-way voice I/O for Claude Code. It runs as a subprocess spawned by Claude Code, communicating over stdio using the MCP protocol.

## Channel Protocol

Unlike tool-based voice solutions (VoiceLayer, VoiceMode), claude-call uses the **MCP channel protocol** — an experimental extension that allows servers to push unsolicited content into Claude's conversation.

When the user speaks, the transcribed text is delivered via:
```
notifications/claude/channel → <channel source="voice">text</channel>
```

Claude processes this identically to typed input. For output, Claude calls the `speak` tool exposed by the channel server.

This bidirectional design means:
- **Input**: Automatic, no tool call needed — Claude sees voice as another input source
- **Output**: Via the `speak` tool — Claude decides when to speak vs. type

## Voice Loop

The main loop in `channel.ts` runs continuously:

```
┌─→ Check muted? ──→ (sleep 100ms, retry) ──→ ↑
│   Check paused? ──→ (sleep 500ms, retry) ──→ ↑
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
- **Signal files**: `/tmp/claude-call-stop` and `/tmp/claude-call-pause` for cross-process coordination

## Data Flow

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
MCP channel notification → Claude Code session
```

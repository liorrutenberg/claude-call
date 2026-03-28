# claude-call Development

## Overview

MCP channel server providing continuous two-way voice I/O for Claude Code.

## Build

```bash
npm install
npm run build        # TypeScript → dist/
npm run typecheck    # tsc --noEmit
npm run dev          # tsc --watch
```

## Project Structure

- `src/channel.ts` — MCP channel server (main entry, voice loop, speak handler)
- `src/cli.ts` — CLI entry point (setup, check, serve commands)
- `src/display-server.ts` — MCP channel server for display push (HTTP POST → channel notification to main session)
- `src/config.ts` — Config loader (~/.claude-call/config.yaml + CLAUDE_CALL_* env vars)
- `src/voice/vad.ts` — Silero VAD v5 (ONNX inference, 512-sample chunks)
- `src/voice/stt.ts` — Whisper STT (server + CLI, two quality modes)
- `src/voice/tts.ts` — TTS cascade (Piper → edge-tts → say) with sentence pipelining
- `src/voice/recorder.ts` — Sox recording, VAD utterance detection, keyword interrupt monitor
- `src/voice/pronunciation.ts` — YAML pronunciation dictionary (hot-reloadable)
- `src/setup/deps.ts` — System dependency checker
- `src/setup/models.ts` — Model downloader with progress bars

## Architecture

Two delivery mechanisms coexist by design:
- **Voice delivery (FIFO)**: Transcribed voice is delivered directly to the headless call session via FIFO (stream-json format). The `speak` tool is exposed for TTS output.
- **Display delivery (MCP channel)**: `display-server.ts` receives HTTP POST from call session agents → sends `notifications/claude/channel` to the main interactive session.

**Voice loop**: record → VAD → transcribe → filter junk → deliver via FIFO (or channel notification in single-session mode)

**Echo suppression**: mute flag prevents recording during TTS playback. `triggerStop()` kills any in-flight recording when TTS starts.

**Keyword interrupt**: Persistent background mic during TTS. VAD detects speech burst → fast STT → check for keywords → `stopSpeaking()` kills playback.

## Key Dependencies

- `onnxruntime-node` — loaded via `createRequire()` because it's a native C++ addon
- `@modelcontextprotocol/sdk` — uses low-level `Server` class (not `McpServer`) for channel protocol access
- `yaml` — config and pronunciation file parsing

## Testing

Prerequisites: sox, whisper-cli. Run `claude-call check` to verify.

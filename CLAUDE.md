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
- `src/config.ts` — Config loader (~/.claude-call/config.yaml + CLAUDE_CALL_* env vars)
- `src/voice/vad.ts` — Silero VAD v5 (ONNX inference, 512-sample chunks)
- `src/voice/stt.ts` — Whisper STT (server + CLI, two quality modes)
- `src/voice/tts.ts` — TTS cascade (Piper → edge-tts → say) with sentence pipelining
- `src/voice/recorder.ts` — Sox recording, VAD utterance detection, keyword interrupt monitor
- `src/voice/pronunciation.ts` — YAML pronunciation dictionary (hot-reloadable)
- `src/setup/deps.ts` — System dependency checker
- `src/setup/models.ts` — Model downloader with progress bars

## Architecture

The channel server uses the MCP `claude/channel` experimental capability. Voice messages arrive in Claude's context as `<channel source="voice">` tags. The `speak` tool is exposed for TTS output.

**Voice loop**: record → VAD → transcribe → filter junk → deliver via channel notification

**Echo suppression**: mute flag prevents recording during TTS playback. `triggerStop()` kills any in-flight recording when TTS starts.

**Keyword interrupt**: Persistent background mic during TTS. VAD detects speech burst → fast STT → check for keywords → `stopSpeaking()` kills playback.

## Key Dependencies

- `onnxruntime-node` — loaded via `createRequire()` because it's a native C++ addon
- `@modelcontextprotocol/sdk` — uses low-level `Server` class (not `McpServer`) for channel protocol access
- `yaml` — config and pronunciation file parsing

## Testing

Prerequisites: sox, whisper-cli. Run `claude-call check` to verify.

# claude-call

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](https://github.com/liorrutenberg/claude-call)

Continuous two-way voice conversations for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Talk to Claude hands-free. Claude talks back. No push-to-talk, no cloud STT, fully local speech processing.

## How It Works

claude-call is an MCP channel server that plugs into Claude Code. Unlike tool-based voice solutions, it uses the **channel protocol** — voice input arrives as `<channel source="voice">`, so Claude treats it identically to a typed message. No explicit tool calls needed.

```
You speak → sox records → Silero VAD detects speech → Whisper transcribes →
  Claude receives text → Claude calls speak tool → TTS synthesizes →
    You hear the response (and can interrupt mid-sentence)
```

## Features

- **Continuous listening** — Silero VAD (ONNX, <1% CPU) detects when you start and stop speaking
- **Echo suppression** — Recording automatically mutes during TTS playback
- **Whisper STT** — Local speech-to-text via whisper.cpp (server mode + CLI fallback)
- **TTS cascade** — Piper (fast, local) → Qwen3 (best quality, opt-in) → edge-tts (Microsoft neural, free) → macOS say (fallback)
- **Sentence pipelining** — Long responses are split into sentences; next sentence synthesizes while current plays
- **Keyword interrupt** — Say "stop", "wait", or "hold on" to kill playback mid-sentence
- **Streaming preview** — Rolling-window partial transcription every 600ms during recording
- **Pronunciation engine** — YAML dictionary for TTS text rewriting and STT vocabulary hints
- **Configurable** — TTS engine, playback rate, silence sensitivity, interrupt keywords, and more

## Comparison

| | Official /voice | VoiceLayer | VoiceMode | **claude-call** |
|---|---|---|---|---|
| Protocol | Built-in | MCP tools | MCP tools | **MCP channel** |
| Input | Push-to-talk | Tool call | Tool call | **Continuous** |
| Output (TTS) | None | Tool call | Tool call | **Automatic** |
| Echo suppression | N/A | File-based | None | **Mute + interrupt** |
| Interrupt | N/A | No | No | **Yes** |
| STT | Cloud | Local | Cloud/local | **Local** |
| Privacy | Cloud | Local | Configurable | **Fully local** |

## Quick Start

### Prerequisites

- **Node.js 18+**
- **sox** — audio recording (`brew install sox`)
- **whisper-cli** — speech-to-text (`brew install whisper-cpp`)
- **Optional:** piper (fast local TTS), edge-tts (neural TTS)

### Install and Setup

```bash
npm install -g claude-call
claude-call setup
```

The setup wizard will:
1. Check system dependencies (sox, whisper-cli, piper, edge-tts)
2. Download models (Silero VAD, Whisper large-v3-turbo, Piper voice)
3. Write config to `~/.claude-call/config.yaml`
4. Add voice server to your project's `.mcp.json`
5. Create `/call-start` and `/call-stop` slash commands in `.claude/commands/`

Then start Claude Code and say `/call-start`.

## Configuration

All settings via `~/.claude-call/config.yaml` or environment variables (`CLAUDE_CALL_*`). Env vars override YAML.

```yaml
tts:
  engine: auto        # auto | piper | qwen3 | edge-tts | say
  voice: en-US-EmmaNeural  # edge-tts voice name
  rate: 1.25          # playback speed
  qwen3Url: http://127.0.0.1:8880  # Qwen3-TTS server (opt-in, see below)

stt:
  serverUrl: ""       # whisper-server URL (blank = use CLI)
  modelSize: base     # base | large-v3-turbo

silence:
  mode: quick         # quick (1s) | standard (1.5s) | thoughtful (2.5s)

interrupt:
  keywords:
    - stop
    - wait
    - hold on
    - pause
    - hey

pronunciation:
  file: ""            # path to custom pronunciation.yaml
```

### Environment Variables

| Variable | Description |
|---|---|
| `CLAUDE_CALL_TTS_ENGINE` | TTS engine: auto, piper, edge-tts, say |
| `CLAUDE_CALL_TTS_VOICE` | edge-tts voice name |
| `CLAUDE_CALL_TTS_RATE` | Playback speed (default: 1.25) |
| `CLAUDE_CALL_TTS_QWEN3_URL` | Qwen3-TTS server URL (default: http://127.0.0.1:8880) |
| `CLAUDE_CALL_WHISPER_SERVER` | Whisper server URL |
| `CLAUDE_CALL_WHISPER_SIZE` | Whisper model size |
| `CLAUDE_CALL_SILENCE_MODE` | Silence detection: quick, standard, thoughtful |
| `CLAUDE_CALL_INTERRUPT_KEYWORDS` | Comma-separated interrupt keywords |
| `CLAUDE_CALL_PRONUNCIATION_FILE` | Custom pronunciation YAML path |
| `CLAUDE_CALL_DATA_DIR` | Data directory (default: ~/.claude-call) |

See [docs/configuration.md](docs/configuration.md) for the full reference.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                Claude Code Session              │
│                                                 │
│  <channel source="voice">transcribed text</...> │
│                     ↑                     │     │
│                     │              speak tool    │
│                     │                     ↓     │
│  ┌──────────────────┴─────────────────────┐     │
│  │         MCP Channel Server             │     │
│  │         (channel.ts)                   │     │
│  │                                        │     │
│  │  Voice Loop        Speak Handler       │     │
│  │  ┌──────────┐     ┌──────────────┐    │     │
│  │  │ Record   │     │ TTS Cascade  │    │     │
│  │  │ ↓        │     │ ↓            │    │     │
│  │  │ VAD      │     │ Sentence     │    │     │
│  │  │ ↓        │     │ Pipeline     │    │     │
│  │  │ Whisper  │     │ ↓            │    │     │
│  │  │ ↓        │     │ Playback     │    │     │
│  │  │ Filter   │     │              │    │     │
│  │  │ ↓        │     │ Keyword      │    │     │
│  │  │ Deliver  │     │ Monitor      │    │     │
│  │  └──────────┘     └──────────────┘    │     │
│  └────────────────────────────────────────┘     │
└─────────────────────────────────────────────────┘
```

See [docs/architecture.md](docs/architecture.md) for the deep dive.

## Pronunciation

The pronunciation dictionary serves two purposes:
1. **TTS**: Rewrites text before synthesis (e.g., "SQL" → "S Q L")
2. **STT**: Provides vocabulary hints to Whisper for better recognition

Default dictionary at `config/pronunciation.yaml` covers common tech terms. Override with your own:

```yaml
# ~/.claude-call/pronunciation.yaml
tech:
  Kubernetes: "Koo-ber-net-ees"
  kubectl: "koob-control"

names:
  Lior: "Lee-or"

acronyms:
  SSV: "S S V"
```

Point to it via config:
```yaml
pronunciation:
  file: ~/.claude-call/pronunciation.yaml
```

## Qwen3-TTS (Optional)

Qwen3 is tier 2 in the TTS cascade but **disabled by default** — it requires a separate GPU daemon that is not installed or started by `claude-call setup`.

When the Qwen3 server isn't running, it's silently skipped and the cascade falls through: Piper → edge-tts → say.

To enable:

1. Install [mlx-audio](https://github.com/lucasnewman/mlx-audio) (Apple Silicon) or equivalent Qwen3-TTS server
2. Start the server manually (default port 8880)
3. Set `CLAUDE_CALL_TTS_QWEN3_URL` if using a non-default port

## CLI Commands

```bash
claude-call setup   # Interactive first-run setup
claude-call check   # Verify dependencies and models
claude-call serve   # Start MCP server (used by Claude Code)
```

## Credits

Built with:
- [Silero VAD](https://github.com/snakers4/silero-vad) (MIT) — Voice activity detection
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (MIT) — Speech-to-text
- [Piper TTS](https://github.com/rhasspy/piper) (MIT) — Local text-to-speech
- [edge-tts](https://github.com/rany2/edge-tts) (GPL-3.0) — Microsoft neural TTS
- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) (MIT) — Model Context Protocol
- [ONNX Runtime](https://github.com/microsoft/onnxruntime) (MIT) — ML inference

Inspired by [VoiceLayer](https://github.com/EtanHey/voicelayer).

## License

[Apache-2.0](LICENSE)

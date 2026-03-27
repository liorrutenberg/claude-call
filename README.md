# claude-call

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](https://github.com/liorrutenberg/claude-call)

Continuous two-way voice conversations for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Talk to Claude hands-free. Claude talks back. Your terminal stays free for typing. No push-to-talk, no cloud STT, fully local speech processing.

## How It Works

claude-call runs a **dual-session architecture**: voice lives in a separate headless Claude session so your main terminal is never blocked.

```
/call-start
  ├─ Main session (interactive terminal) — typing, tools, normal Claude Code
  └─ Call session (headless claude -p) — owns the mic, speaks responses,
       delegates heavy work to background agents
```

Under the hood, the call session is an MCP channel server using the **channel protocol** — voice input arrives as `<channel source="voice">`, so Claude treats it identically to a typed message. No explicit tool calls needed.

```
You speak → sox records → Silero VAD detects speech → Whisper transcribes →
  Call session receives text → acks immediately → dispatches background agents →
    speaks result via TTS → you hear the response (and can interrupt mid-sentence)
```

## Features

### Dual Session Model
- **Terminal stays free** — Voice runs in a separate headless session; type normally while talking
- **`/call-start` and `/call-stop`** — Start and stop voice from any Claude Code session
- **Background delegation** — Call session dispatches heavy work (memory searches, file reads, multi-step research) to background agents so you never wait in silence
- **Artifact workspace** — Call session writes reports and detailed output to `.exo-call/artifacts/` for the main session to read
- **Audio feedback** — Thinking pulse (waiting for response), start/resume chime, pause chime — so you always know the system state

### Voice Engine
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
- **Homebrew** (macOS)

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/liorrutenberg/claude-call/main/install.sh | bash
```

### Setup

Run from your project directory:

```bash
claude-call setup
```

Setup installs all dependencies (sox, whisper-cpp, piper, edge-tts), downloads models (Silero VAD, Whisper large-v3-turbo, Piper voice), starts a whisper-server in the background for faster transcription, writes config, and creates `/call-start` and `/call-stop` slash commands.

### Start a Voice Call

From Claude Code:

```
/call-start
```

This spawns a separate voice session. Your main terminal stays free for typing.

Stop the call with:

```
/call-stop
```

> **Multiple projects?** Run `claude-call setup` from each project directory. It adds the slash commands to whichever project you run it from.

## Voice Commands

Once a voice session is active, you can control it hands-free:

| Command | What it does |
|---|---|
| **"exo"** | Say the wake word while Claude is speaking to **interrupt** playback mid-sentence |
| **"exo pause"** | **Pause** voice input — the mic stays alive but stops processing speech |
| **"exo start"** | **Resume** voice input after a pause |

Whisper sometimes mishears these phrases, so common variants (e.g., "echo pause", "exo resume") are recognized automatically.

> **Configurable:** The interrupt keywords and wake word can be changed in `~/.claude-call/config.yaml` under the `interrupt.keywords` section. See [docs/configuration.md](docs/configuration.md) for details.

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
    - step
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
┌─────────────────────────────────┐
│  MAIN SESSION (interactive)     │
│  No voice MCP loaded            │
│  /call-start → spawns call      │
│  /call-stop  → kills call       │
│  Terminal stays 100% free       │
│  Reads artifacts from .exo-call/│
└────────────┬────────────────────┘
             │ .exo-call/ (shared workspace)
┌────────────┴────────────────────┐
│  CALL SESSION (headless)        │
│  claude -p + stream-json + FIFO │
│  Voice MCP (sole mic owner)     │
│                                 │
│  Voice Loop        Speak Handler│
│  ┌──────────┐     ┌───────────┐ │
│  │ Record   │     │ TTS       │ │
│  │ ↓        │     │ Cascade   │ │
│  │ VAD      │     │ ↓         │ │
│  │ ↓        │     │ Sentence  │ │
│  │ Whisper  │     │ Pipeline  │ │
│  │ ↓        │     │ ↓         │ │
│  │ Filter   │     │ Playback  │ │
│  │ ↓        │     │ ↓         │ │
│  │ FIFO     │     │ Keyword   │ │
│  │ Deliver  │     │ Monitor   │ │
│  └──────────┘     └───────────┘ │
│                                 │
│  Audio Feedback                 │
│  ┌───────────────────────────┐  │
│  │ Thinking pulse (waiting)  │  │
│  │ Start / resume chime      │  │
│  │ Pause chime               │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

### Shared Workspace

```
.exo-call/
├── session.json      # PIDs, paths, status
├── inbox.jsonl       # Machine-readable events (call → main)
└── artifacts/        # Reports, summaries, detailed output
    └── *.md
```

The call session speaks concise summaries. When you say "show it" or "put it in the workspace", detailed output is written to `artifacts/` where the main session can read it.

See [docs/architecture.md](docs/architecture.md) for the voice engine internals and [docs/call-session-v2.md](docs/call-session-v2.md) for the full dual-session design.

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

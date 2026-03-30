# claude-call

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](https://github.com/liorrutenberg/claude-call)

Voice companion for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Talk to Claude hands-free while your terminal stays free for typing. Voice runs in a headless background session — it listens, responds via TTS, and dispatches background agents for heavy work. Results get pushed to your main screen so you never waste context — side lookups, checks, and research happen in the voice session, and only what matters gets injected into your main session.

No push-to-talk, no cloud STT, fully local speech processing.

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
- **Display push** — Call session pushes agent monitor events to the main session via MCP channel notification
- **Audio feedback** — Speech start/end beeps (VAD confirmation), thinking pulse, start/unmute chime, mute chime — so you always know the system state

### Voice Filtering
- **Volume gate** — RMS amplitude filter rejects background noise (configurable threshold via `claude-call calibrate`)
- **Speaker verification** — Optional voice ID using WeSpeaker embeddings; only processes the enrolled speaker's voice (`claude-call enroll`)

### Voice Engine
- **Continuous listening** — Silero VAD (ONNX, <1% CPU) detects when you start and stop speaking
- **Echo suppression** — Recording automatically mutes during TTS playback
- **Whisper STT** — Local speech-to-text via whisper.cpp (server mode + CLI fallback)
- **TTS cascade** — Piper (fast, local) → Qwen3 (best quality, opt-in) → edge-tts (Microsoft neural, free) → macOS say (fallback)
- **Sentence pipelining** — Long responses are split into sentences; next sentence synthesizes while current plays
- **Keyword interrupt** — Say "stop", "hold on", or "exo" to kill playback mid-sentence
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

```bash
claude-call install    # once — deps, models, skills, PATH
claude-call init       # per project — .mcp.json for display channel
```

`install` installs all dependencies (sox, whisper-cpp, piper, edge-tts), downloads models (Silero VAD, Whisper large-v3-turbo, Piper voice), starts a whisper-server, writes config, and installs `/call-start` and `/call-stop` slash commands.

`init` configures the current project for voice calls (adds the display channel MCP entry to `.mcp.json`).

### Start a Voice Call

**Option A: Launcher scripts (recommended)**

Add `~/.claude-call/bin` to your PATH, then:

```bash
eld       # Claude + voice (like cld)
eldc      # Claude + voice, continue last conversation
eldr      # Claude + voice, continue last conversation (resume)
```

Voice starts automatically and stops when you exit Claude. No manual cleanup needed.

> **Note:** If the wrapper shell itself is force-killed (`kill -9` on the shell PID) or the terminal app crashes, the cleanup trap can't fire. Run `claude-call call stop` from the same project directory to clean up the orphaned voice session. Normal exits (Ctrl+C, `/exit`, closing the terminal window) are handled automatically.

**Option B: Manual control**

Start Claude Code with the display channel enabled:

```bash
claude --dangerously-load-development-channels server:call-display
```

Then from Claude Code:

```
/call-start
```

This spawns a separate voice session. Your main terminal stays free for typing.

Stop the call with:

```
/call-stop
```

> **Multiple projects?** Run `claude-call init` from each project directory.

## Voice Commands

Once a voice session is active, you can control it hands-free:

| Command | What it does |
|---|---|
| **"exo"** | Say the wake word while Claude is speaking to **interrupt** playback mid-sentence |
| **"exo mute"** | **Mute** voice input — mic listens only for unmute, agents keep running |
| **"exo unmute"** / **"exo start"** | **Unmute** voice input — Claude summarizes what happened while muted |

Whisper sometimes mishears these phrases, so common variants (e.g., "echo mute", "echo unmute") are recognized automatically.

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
    - hold on
    - pause
    - exo

pronunciation:
  file: ""            # path to custom pronunciation.yaml

volumeGate:
  enabled: false      # enable RMS volume gate
  minRms: 0           # minimum RMS amplitude (0-1), use `claude-call calibrate` to set

speaker:
  enabled: false      # enable speaker verification
  threshold: 0.55     # cosine similarity threshold (0-1)
  modelPath: ~/.claude-call/models/wespeaker_en_voxceleb_resnet34_LM.onnx
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
| `CLAUDE_CALL_VOLUME_GATE_MIN_RMS` | Volume gate RMS threshold (0-1, enables gate if > 0) |
| `CLAUDE_CALL_SPEAKER_ENABLED` | Enable speaker verification |
| `CLAUDE_CALL_SPEAKER_THRESHOLD` | Speaker verification cosine similarity threshold |

See [docs/configuration.md](docs/configuration.md) for the full reference.

## Architecture

```
┌─────────────────────────────────┐
│  MAIN SESSION (interactive)     │
│  No voice MCP loaded            │
│  /call-start → spawns call      │
│  /call-stop  → kills call       │
│  Terminal stays 100% free       │
│  call-display MCP (channel push)│
└────────────┬────────────────────┘
             │ HTTP localhost:9847 (display push)
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
│  │ Speech start/end beeps    │  │
│  │ Thinking pulse (waiting)  │  │
│  │ Start / unmute chime       │  │
│  │ Mute chime                │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

### Display Push

The call session speaks concise summaries. Background agents post monitor events (dispatch/complete) via HTTP POST to the display MCP server (`localhost:9847`), which forwards them as MCP channel notifications to the main session's TUI monitor.

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

Qwen3 is tier 2 in the TTS cascade but **disabled by default** — it requires a separate GPU daemon that is not installed or started by `claude-call install`.

When the Qwen3 server isn't running, it's silently skipped and the cascade falls through: Piper → edge-tts → say.

To enable:

1. Install [mlx-audio](https://github.com/lucasnewman/mlx-audio) (Apple Silicon) or equivalent Qwen3-TTS server
2. Start the server manually (default port 8880)
3. Set `CLAUDE_CALL_TTS_QWEN3_URL` if using a non-default port

## CLI Commands

```bash
claude-call install     # Global setup (deps, models, skills, PATH)
claude-call init        # Per-project setup (.mcp.json)
claude-call uninstall   # Remove everything (--dry-run to preview)
claude-call check       # Verify dependencies and models
claude-call serve       # Start MCP server (used by Claude Code)
claude-call enroll      # Record voice samples for speaker verification
claude-call calibrate   # Set volume threshold for voice filtering
claude-call call start  # Start a voice call session
claude-call call stop   # Stop the current call session
claude-call call mute   # Mute voice input (agents keep running)
claude-call call unmute # Unmute voice input
claude-call call status # Show call session status
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

## Security

The headless call session runs with `--dangerously-skip-permissions` because it cannot prompt for user confirmation. This means voice-triggered actions (file writes, bash commands) execute without approval. Background agents dispatched by the call session inherit this permission level.

**Mitigations:**
- Voice MCP runs only when explicitly started via `/call-start`
- Whisper's junk filter prevents hallucinated commands from being processed
- All processing is local — no data leaves your machine

Be aware that a misheard transcript could trigger unintended actions. Use the wake word prefix (`/call-prefix-on`) in noisy environments.

## License

[Apache-2.0](LICENSE)

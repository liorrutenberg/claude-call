# Configuration Reference

claude-call loads configuration from two sources, with env vars taking priority:

1. `~/.claude-call/config.yaml` — YAML config file
2. `CLAUDE_CALL_*` environment variables — override any YAML setting

## Full Config Schema

```yaml
# Data directory for models, logs, and config
# Default: ~/.claude-call
# Env: CLAUDE_CALL_DATA_DIR
dataDir: ~/.claude-call

tts:
  # TTS engine selection
  # auto: tries Piper → Qwen3 → edge-tts → say (first available wins)
  # piper: Piper only (fails if unavailable)
  # qwen3: Qwen3-TTS only (requires running server)
  # edge-tts: edge-tts only
  # say: macOS say only
  # Default: auto
  # Env: CLAUDE_CALL_TTS_ENGINE
  engine: auto

  # edge-tts voice name
  # Default: en-US-EmmaNeural
  # Env: CLAUDE_CALL_TTS_VOICE
  voice: en-US-EmmaNeural

  # Playback speed multiplier
  # Default: 1.25
  # Env: CLAUDE_CALL_TTS_RATE
  rate: 1.25

  # Path to Piper ONNX model file
  # Default: ~/.claude-call/models/en_US-lessac-medium.onnx
  # Env: CLAUDE_CALL_PIPER_MODEL
  piperModel: ~/.claude-call/models/en_US-lessac-medium.onnx

  # Qwen3-TTS server URL (opt-in)
  # Requires a separately installed and running Qwen3-TTS GPU daemon.
  # When the server isn't reachable, this tier is silently skipped.
  # Default: http://127.0.0.1:8880
  # Env: CLAUDE_CALL_TTS_QWEN3_URL
  qwen3Url: http://127.0.0.1:8880

stt:
  # Whisper server URL (HTTP API)
  # If set and server is reachable, uses server mode (faster, model stays loaded)
  # If empty or unreachable, falls back to whisper-cli
  # Default: "" (CLI mode)
  # Env: CLAUDE_CALL_WHISPER_SERVER
  serverUrl: ""

  # Explicit path to whisper model file
  # If empty, auto-detects in ~/.claude-call/models/
  # Default: "" (auto-detect)
  # Env: CLAUDE_CALL_WHISPER_MODEL
  modelPath: ""

  # Whisper model size (used for auto-detection and setup)
  # Default: base
  # Env: CLAUDE_CALL_WHISPER_SIZE
  modelSize: base

silence:
  # How long silence must last before ending an utterance
  # quick: 1.0s — responsive, good for short commands
  # standard: 1.5s — balanced
  # thoughtful: 2.5s — for longer, more considered speech
  # Default: quick
  # Env: CLAUDE_CALL_SILENCE_MODE
  mode: quick

interrupt:
  # Keywords that trigger TTS interruption when spoken during playback
  # The keyword monitor runs a persistent background mic during TTS,
  # detects speech bursts via VAD, and fast-transcribes to check for matches
  # Default: [stop, hold on, pause, exo]
  # Env: CLAUDE_CALL_INTERRUPT_KEYWORDS (comma-separated)
  keywords:
    - stop
    - hold on
    - pause
    - exo

pronunciation:
  # Path to custom pronunciation YAML dictionary
  # If empty, uses the bundled default at config/pronunciation.yaml
  # Default: ""
  # Env: CLAUDE_CALL_PRONUNCIATION_FILE
  file: ""

volumeGate:
  # Enable volume gate — rejects audio below a minimum RMS amplitude.
  # Use `claude-call calibrate` to find the right threshold for your mic.
  # Default: false
  enabled: false

  # Minimum RMS amplitude (0-1). Audio below this threshold is rejected.
  # Set to 0 to disable. Use `claude-call calibrate` to determine a good value.
  # Default: 0
  # Env: CLAUDE_CALL_VOLUME_GATE_MIN_RMS (setting > 0 also enables the gate)
  minRms: 0

speaker:
  # Enable speaker verification — only process audio from the enrolled speaker.
  # Requires sherpa-onnx-node and a downloaded WeSpeaker model.
  # Gracefully degrades: if not available, all audio passes through.
  # Default: false
  # Env: CLAUDE_CALL_SPEAKER_ENABLED
  enabled: false

  # Cosine similarity threshold for speaker matching (0-1).
  # Higher = stricter matching, lower = more permissive.
  # Default: 0.55
  # Env: CLAUDE_CALL_SPEAKER_THRESHOLD
  threshold: 0.55

  # Path to WeSpeaker ONNX model file
  # Default: ~/.claude-call/models/wespeaker_en_voxceleb_resnet34_LM.onnx
  modelPath: ~/.claude-call/models/wespeaker_en_voxceleb_resnet34_LM.onnx
```

## Whisper Server Mode

For faster transcription (model stays loaded in memory), run a whisper-server:

```bash
# Start whisper-server (from whisper.cpp)
whisper-server -m ~/.claude-call/models/ggml-base.bin --port 8178

# Point claude-call at it
export CLAUDE_CALL_WHISPER_SERVER=http://127.0.0.1:8178
```

Server mode reduces transcription latency from ~1100ms (CLI, model load each time) to ~100-300ms.

## Silence Modes

| Mode | Duration | Best For |
|---|---|---|
| `quick` | 1.0s | Short commands, rapid back-and-forth |
| `standard` | 1.5s | Normal conversation |
| `thoughtful` | 2.5s | Longer, considered speech with natural pauses |

## TTS Engine Cascade

In `auto` mode, claude-call tries engines in order:

1. **Piper** — Local ONNX model, ~100ms latency, offline. Needs `piper` binary + model.
2. **Qwen3-TTS** — Best quality, fully local GPU inference. Opt-in: requires a separately running daemon (not installed by `claude-call install`). Silently skipped when server isn't reachable.
3. **edge-tts** — Microsoft neural voices, free, high quality. Needs `edge-tts` CLI + internet.
4. **say** — macOS built-in. Always available, robotic but reliable.

Set `engine` to a specific value to skip the cascade and use only that engine.

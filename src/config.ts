/**
 * Configuration loader.
 *
 * Reads from ~/.claude-call/config.yaml (optional) with env var overrides (CLAUDE_CALL_*).
 * Provides sensible defaults so the plugin works out of the box after setup.
 */

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

// ─── Types ──────────────────────────────────────────────────

export type SilenceMode = 'quick' | 'standard' | 'thoughtful'

export interface TtsConfig {
  engine: 'auto' | 'piper' | 'qwen3' | 'edge-tts' | 'say'
  voice: string
  rate: number
  piperModel: string
  qwen3Url: string
}

export interface SttConfig {
  serverUrl: string
  modelPath: string
  modelSize: string
}

export interface SilenceConfig {
  mode: SilenceMode
}

export interface InterruptConfig {
  keywords: string[]
}

export interface PronunciationConfig {
  file: string
}

export interface FeedbackConfig {
  enabled: boolean
  volume: number
}

export interface WakeWordConfig {
  enabled: boolean
}

export interface VolumeGateConfig {
  enabled: boolean
  minRms: number  // 0-1 float, minimum RMS amplitude to process. 0 = disabled
}

export interface SpeakerConfig {
  enabled: boolean
  threshold: number  // cosine similarity threshold (0-1), default 0.55
  modelPath: string  // path to speaker embedding ONNX model
}

export interface Config {
  dataDir: string
  tts: TtsConfig
  stt: SttConfig
  silence: SilenceConfig
  interrupt: InterruptConfig
  pronunciation: PronunciationConfig
  feedback: FeedbackConfig
  wakeWord: WakeWordConfig
  volumeGate: VolumeGateConfig
  speaker: SpeakerConfig
}

// ─── Defaults ───────────────────────────────────────────────

const DATA_DIR = join(homedir(), '.claude-call')

function defaults(): Config {
  return {
    dataDir: DATA_DIR,
    tts: {
      engine: 'auto',
      voice: 'en-US-EmmaNeural',
      rate: 1.25,
      piperModel: join(DATA_DIR, 'models', 'en_US-lessac-medium.onnx'),
      qwen3Url: 'http://127.0.0.1:8880',
    },
    stt: {
      serverUrl: '',
      modelPath: '',
      modelSize: 'base',
    },
    silence: {
      mode: 'quick',
    },
    interrupt: {
      keywords: ['stop', 'hold on', 'pause', 'exo'],
    },
    pronunciation: {
      file: '',
    },
    feedback: {
      enabled: true,
      volume: 0.3,
    },
    wakeWord: {
      enabled: false,
    },
    volumeGate: {
      enabled: false,
      minRms: 0,
    },
    speaker: {
      enabled: false,
      threshold: 0.35,
      modelPath: join(DATA_DIR, 'models', 'wespeaker_en_voxceleb_resnet34_LM.onnx'),
    },
  }
}

// ─── YAML loading ───────────────────────────────────────────

interface YamlConfig {
  dataDir?: string
  tts?: Partial<TtsConfig>
  stt?: Partial<SttConfig>
  silence?: Partial<SilenceConfig>
  interrupt?: Partial<InterruptConfig>
  pronunciation?: Partial<PronunciationConfig>
  feedback?: Partial<FeedbackConfig>
  wakeWord?: Partial<WakeWordConfig>
  volumeGate?: Partial<VolumeGateConfig>
  speaker?: Partial<SpeakerConfig>
}

function loadYaml(path: string): YamlConfig {
  if (!existsSync(path)) return {}
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = parseYaml(raw) as YamlConfig | null
    return parsed ?? {}
  } catch {
    return {}
  }
}

// ─── Env overrides ──────────────────────────────────────────

function env(key: string): string | undefined {
  return process.env[`CLAUDE_CALL_${key}`]
}

function applyEnvOverrides(config: Config): void {
  const dataDir = env('DATA_DIR')
  if (dataDir) config.dataDir = dataDir

  const ttsEngine = env('TTS_ENGINE')
  if (ttsEngine) config.tts.engine = ttsEngine as Config['tts']['engine']

  const ttsVoice = env('TTS_VOICE')
  if (ttsVoice) config.tts.voice = ttsVoice

  const ttsRate = env('TTS_RATE')
  if (ttsRate) {
    const parsed = parseFloat(ttsRate)
    if (!isNaN(parsed) && parsed > 0) config.tts.rate = parsed
  }

  const piperModel = env('PIPER_MODEL')
  if (piperModel) config.tts.piperModel = piperModel

  const qwen3Url = env('TTS_QWEN3_URL')
  if (qwen3Url) config.tts.qwen3Url = qwen3Url

  const sttServer = env('WHISPER_SERVER')
  if (sttServer) config.stt.serverUrl = sttServer

  const sttModel = env('WHISPER_MODEL')
  if (sttModel) config.stt.modelPath = sttModel

  const sttSize = env('WHISPER_SIZE')
  if (sttSize) config.stt.modelSize = sttSize

  const silenceMode = env('SILENCE_MODE')
  if (silenceMode) config.silence.mode = silenceMode as SilenceMode

  const keywords = env('INTERRUPT_KEYWORDS')
  if (keywords) config.interrupt.keywords = keywords.split(',').map(k => k.trim())

  const pronFile = env('PRONUNCIATION_FILE')
  if (pronFile) config.pronunciation.file = pronFile

  const wakeWordEnabled = env('WAKE_WORD_ENABLED')
  if (wakeWordEnabled !== undefined) config.wakeWord.enabled = wakeWordEnabled !== 'false' && wakeWordEnabled !== '0'

  const volumeGateMinRms = env('VOLUME_GATE_MIN_RMS')
  if (volumeGateMinRms) {
    const parsed = parseFloat(volumeGateMinRms)
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
      config.volumeGate.minRms = parsed
      if (parsed > 0) config.volumeGate.enabled = true
    }
  }

  const speakerEnabled = env('SPEAKER_ENABLED')
  if (speakerEnabled !== undefined) config.speaker.enabled = speakerEnabled !== 'false' && speakerEnabled !== '0'

  const speakerThreshold = env('SPEAKER_THRESHOLD')
  if (speakerThreshold) {
    const parsed = parseFloat(speakerThreshold)
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) config.speaker.threshold = parsed
  }
}

// ─── Merge ──────────────────────────────────────────────────

function merge(base: Config, yaml: YamlConfig): Config {
  return {
    dataDir: yaml.dataDir ?? base.dataDir,
    tts: { ...base.tts, ...yaml.tts },
    stt: { ...base.stt, ...yaml.stt },
    silence: { ...base.silence, ...yaml.silence },
    interrupt: {
      keywords: yaml.interrupt?.keywords ?? base.interrupt.keywords,
    },
    pronunciation: { ...base.pronunciation, ...yaml.pronunciation },
    feedback: { ...base.feedback, ...yaml.feedback },
    wakeWord: { ...base.wakeWord, ...yaml.wakeWord },
    volumeGate: { ...base.volumeGate, ...yaml.volumeGate },
    speaker: { ...base.speaker, ...yaml.speaker },
  }
}

// ─── Public API ─────────────────────────────────────────────

let cached: Config | null = null
let cachedMtime: number = 0

export function loadConfig(): Config {
  const configPath = join(DATA_DIR, 'config.yaml')

  // Auto-reload when config file changes
  try {
    const mtime = existsSync(configPath) ? statSync(configPath).mtimeMs : 0
    if (cached && mtime === cachedMtime) return cached
    cachedMtime = mtime
  } catch {
    if (cached) return cached
  }

  const base = defaults()
  const yaml = loadYaml(configPath)
  const config = merge(base, yaml)
  applyEnvOverrides(config)

  // Expand ~ in paths
  if (config.speaker.modelPath.startsWith('~')) {
    config.speaker.modelPath = config.speaker.modelPath.replace('~', homedir())
  }

  cached = config
  return config
}

/** Force config reload on next access */
export function invalidateConfig(): void {
  cached = null
  cachedMtime = 0
}

export function getModelsDir(): string {
  return join(loadConfig().dataDir, 'models')
}

export function getLogDir(): string {
  return join(loadConfig().dataDir, 'logs')
}

/** Write specific config fields to config.yaml (merge, not overwrite). */
export function writeConfig(patch: Partial<YamlConfig>): void {
  const configPath = join(DATA_DIR, 'config.yaml')
  mkdirSync(DATA_DIR, { recursive: true })

  let existing: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    try {
      existing = (parseYaml(readFileSync(configPath, 'utf-8')) as Record<string, unknown>) ?? {}
    } catch { /* start fresh */ }
  }

  // Deep merge one level: top-level keys with object values get spread-merged
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        existing[key] && typeof existing[key] === 'object' && !Array.isArray(existing[key])) {
      existing[key] = { ...(existing[key] as Record<string, unknown>), ...(value as Record<string, unknown>) }
    } else {
      existing[key] = value
    }
  }

  writeFileSync(configPath, stringifyYaml(existing), 'utf-8')
  invalidateConfig()
}

// Re-export per-run helpers from runtime module
export { getProjectHash, getRunDir } from './runtime.js'

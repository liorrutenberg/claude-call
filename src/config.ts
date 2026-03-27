/**
 * Configuration loader.
 *
 * Reads from ~/.claude-call/config.yaml (optional) with env var overrides (CLAUDE_CALL_*).
 * Provides sensible defaults so the plugin works out of the box after setup.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseYaml } from 'yaml'

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

export interface Config {
  dataDir: string
  tts: TtsConfig
  stt: SttConfig
  silence: SilenceConfig
  interrupt: InterruptConfig
  pronunciation: PronunciationConfig
  feedback: FeedbackConfig
  wakeWord: WakeWordConfig
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
      keywords: ['stop', 'wait', 'hold on', 'pause', 'hey'],
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
  }
}

// ─── Public API ─────────────────────────────────────────────

let cached: Config | null = null

export function loadConfig(): Config {
  if (cached) return cached

  const base = defaults()
  const configPath = join(base.dataDir, 'config.yaml')
  const yaml = loadYaml(configPath)
  const config = merge(base, yaml)
  applyEnvOverrides(config)

  cached = config
  return config
}

export function getModelsDir(): string {
  return join(loadConfig().dataDir, 'models')
}

export function getLogDir(): string {
  return join(loadConfig().dataDir, 'logs')
}

// Re-export per-run helpers from runtime module
export { getProjectHash, getRunDir } from './runtime.js'

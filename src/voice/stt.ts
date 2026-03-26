/**
 * Speech-to-text via whisper.cpp.
 *
 * Two-tier architecture:
 *   1. whisper-server (HTTP, model stays loaded) — fast (~100-300ms)
 *   2. whisper-cli (subprocess, loads model each time) — fallback (~1100ms)
 *
 * Two quality modes:
 *   - transcribe(): accurate, beam search + domain prompt
 *   - transcribeFast(): speed-first, no beam search (for previews + keyword checks)
 */

import { existsSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { getDomainTerms } from './pronunciation.js'
import { loadConfig, getModelsDir } from '../config.js'

// ─── Constants ──────────────────────────────────────────────

const MODEL_NAMES = [
  'ggml-large-v3-turbo.bin',
  'ggml-large-v3-turbo-q5_0.bin',
  'ggml-base.bin',
]

const WHISPER_BINARY_SEARCH = [
  '/opt/homebrew/bin/whisper-cli',
  '/usr/local/bin/whisper-cli',
  '/opt/homebrew/bin/whisper',
  '/usr/local/bin/whisper',
]

const BREW_PREFIX = '/opt/homebrew/opt/whisper-cpp'

// ─── Domain vocabulary prompt ───────────────────────────────

let cachedPrompt: string | null = null

function getWhisperPrompt(): string {
  if (cachedPrompt) return cachedPrompt
  const terms = getDomainTerms()
  cachedPrompt = terms.length > 0
    ? `Technical voice transcript. Terms may include ${terms.join(', ')}.`
    : 'Technical voice transcript.'
  return cachedPrompt
}

// ─── Binary detection ───────────────────────────────────────

let cachedBinary: string | null = null

function findWhisperBinary(): string | null {
  if (cachedBinary) return cachedBinary
  for (const path of WHISPER_BINARY_SEARCH) {
    if (existsSync(path)) {
      cachedBinary = path
      return path
    }
  }
  return null
}

// ─── Metal shader env (GPU acceleration on macOS) ───────────

let cachedEnv: Record<string, string> | null = null

function getWhisperEnv(): Record<string, string> {
  if (cachedEnv) return cachedEnv
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  const metalPath = join(BREW_PREFIX, 'share', 'whisper-cpp')
  if (existsSync(metalPath)) {
    env.GGML_METAL_PATH_RESOURCES = metalPath
  }
  cachedEnv = env
  return env
}

// ─── Model path ─────────────────────────────────────────────

let cachedModel: string | null | undefined

function findModel(): string | null {
  const modelsDir = getModelsDir()
  const config = loadConfig()

  // Explicit path from config
  if (config.stt.modelPath && existsSync(config.stt.modelPath)) {
    return config.stt.modelPath
  }

  // Search by preference order
  for (const name of MODEL_NAMES) {
    const p = join(modelsDir, name)
    if (existsSync(p)) return p
  }
  return null
}

export function getModelPath(): string {
  if (cachedModel !== undefined) return cachedModel!
  cachedModel = findModel()
  if (!cachedModel) {
    throw new Error(
      'No whisper model found.\n' +
      'Run "claude-call setup" to download a model.'
    )
  }
  return cachedModel
}

// ─── Whisper Server (HTTP) ──────────────────────────────────

let serverAvailable: boolean | null = null

function getServerUrl(): string {
  return loadConfig().stt.serverUrl || ''
}

async function isServerAvailable(): Promise<boolean> {
  if (serverAvailable !== null) return serverAvailable

  const url = getServerUrl()
  if (!url) { serverAvailable = false; return false }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)
    const res = await fetch(`${url}/health`, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) { serverAvailable = false; return false }
    const data = (await res.json()) as { status: string }
    serverAvailable = data.status === 'ok'
    return serverAvailable
  } catch {
    serverAvailable = false
    return false
  }
}

async function transcribeViaServer(wavPath: string, fast: boolean): Promise<string> {
  const url = getServerUrl()
  const wavData = readFileSync(wavPath)
  const blob = new Blob([wavData], { type: 'audio/wav' })
  const formData = new FormData()
  formData.append('file', blob, 'audio.wav')
  formData.append('response_format', 'json')
  formData.append('temperature', '0.0')
  formData.append('language', 'en')
  formData.append('suppress_nst', 'true')

  if (!fast) {
    formData.append('beam_size', '5')
    formData.append('best_of', '5')
    formData.append('prompt', getWhisperPrompt())
  }

  const timeout_ms = fast ? 8_000 : 15_000
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeout_ms)
  try {
    const res = await fetch(`${url}/inference`, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) throw new Error(`whisper-server: ${res.status}`)
    const data = (await res.json()) as { text?: string }
    return (data.text ?? '').trim()
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Whisper CLI (subprocess) ───────────────────────────────

function transcribeViaCLI(wavPath: string, fast: boolean): Promise<string> {
  const binary = findWhisperBinary()
  if (!binary) {
    throw new Error(
      'whisper-cli not found.\n' +
      'Install: brew install whisper-cpp'
    )
  }

  const model = getModelPath()
  const args = ['-m', model, '-f', wavPath, '--no-timestamps', '-l', 'en']

  if (!fast) {
    args.push('--beam-size', '5', '--best-of', '5', '--prompt', getWhisperPrompt())
  }

  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: fast ? 15_000 : 30_000, env: getWhisperEnv() },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`whisper-cli failed: ${err.message}\n${stderr}`))
          return
        }
        const text = stdout
          .split('\n')
          .map(l => l.replace(/^\[.*?]\s*/, '').trim())
          .filter(Boolean)
          .join(' ')
          .trim()
        resolve(text)
      }
    )
  })
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Transcribe a WAV file to text (accurate, with beam search + domain prompt).
 * Tries whisper-server first, falls back to CLI.
 */
export async function transcribe(wavPath: string): Promise<string> {
  if (!existsSync(wavPath)) return ''

  if (await isServerAvailable()) {
    return transcribeViaServer(wavPath, false)
  }
  return transcribeViaCLI(wavPath, false)
}

/**
 * Fast transcription (speed over accuracy — no beam search, no prompt).
 * For streaming previews and keyword detection where latency matters.
 */
export async function transcribeFast(wavPath: string): Promise<string> {
  if (!existsSync(wavPath)) return ''

  if (await isServerAvailable()) {
    return transcribeViaServer(wavPath, true)
  }
  return transcribeViaCLI(wavPath, true)
}

/**
 * Model downloader with progress bars.
 *
 * Downloads Silero VAD, Whisper, and Piper models to ~/.claude-call/models/.
 * Uses HTTP with progress reporting via stderr.
 */

import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { get as httpGet, type IncomingMessage } from 'node:http'
import { getModelsDir } from '../config.js'

export interface ModelInfo {
  name: string
  filename: string
  url: string
  sizeHint: string
  required: boolean
}

export const MODELS: Record<string, ModelInfo> = {
  vad: {
    name: 'Silero VAD',
    filename: 'silero_vad.onnx',
    url: 'https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx',
    sizeHint: '~2.2 MB',
    required: true,
  },
  'whisper-base': {
    name: 'Whisper Base',
    filename: 'ggml-base.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    sizeHint: '~141 MB',
    required: false,
  },
  'whisper-large': {
    name: 'Whisper Large v3 Turbo',
    filename: 'ggml-large-v3-turbo.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    sizeHint: '~1.5 GB',
    required: false,
  },
  'piper-voice': {
    name: 'Piper Voice (en_US-lessac-medium)',
    filename: 'en_US-lessac-medium.onnx',
    url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx',
    sizeHint: '~61 MB',
    required: false,
  },
  'piper-voice-config': {
    name: 'Piper Voice Config',
    filename: 'en_US-lessac-medium.onnx.json',
    url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json',
    sizeHint: '~5 KB',
    required: false,
  },
}

function followRedirects(url: string, maxRedirects = 5): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'))
      return
    }

    const getter = url.startsWith('https') ? httpsGet : httpGet
    getter(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const location = res.headers.location.startsWith('/')
          ? new URL(res.headers.location, url).href
          : res.headers.location
        followRedirects(location, maxRedirects - 1).then(resolve, reject)
        return
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      resolve(res)
    }).on('error', reject)
  })
}

export async function downloadModel(model: ModelInfo, onProgress?: (pct: number) => void): Promise<string> {
  const modelsDir = getModelsDir()
  mkdirSync(modelsDir, { recursive: true })

  const destPath = `${modelsDir}/${model.filename}`
  const tmpPath = `${destPath}.download`

  if (existsSync(destPath)) return destPath

  const res = await followRedirects(model.url)
  const total = parseInt(res.headers['content-length'] ?? '0', 10)

  return new Promise((resolve, reject) => {
    const ws = createWriteStream(tmpPath)
    let downloaded = 0

    res.on('data', (chunk: Buffer) => {
      downloaded += chunk.length
      ws.write(chunk)
      if (total > 0 && onProgress) {
        onProgress(Math.min(100, Math.round((downloaded / total) * 100)))
      }
    })

    res.on('end', () => {
      ws.end(() => {
        try {
          renameSync(tmpPath, destPath)
          resolve(destPath)
        } catch (err) {
          reject(err)
        }
      })
    })

    res.on('error', (err) => {
      ws.end()
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
      reject(err)
    })

    ws.on('error', (err) => {
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
      reject(err)
    })
  })
}

/** Print a progress bar to stderr. */
export function printProgress(label: string, pct: number): void {
  const width = 30
  const filled = Math.round(width * pct / 100)
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled)
  process.stderr.write(`\r  ${label} ${bar} ${pct}%`)
  if (pct >= 100) process.stderr.write('\n')
}

export async function downloadWithProgress(model: ModelInfo): Promise<string> {
  const modelsDir = getModelsDir()
  const destPath = `${modelsDir}/${model.filename}`
  if (existsSync(destPath)) {
    process.stderr.write(`  ${model.name}: already downloaded\n`)
    return destPath
  }

  process.stderr.write(`  ${model.name} (${model.sizeHint})\n`)
  let lastPct = -1
  const path = await downloadModel(model, (pct) => {
    if (pct !== lastPct) { lastPct = pct; printProgress(model.name, pct) }
  })
  return path
}

export function isModelDownloaded(key: string): boolean {
  const model = MODELS[key]
  if (!model) return false
  return existsSync(`${getModelsDir()}/${model.filename}`)
}

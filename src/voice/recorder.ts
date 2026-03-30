/**
 * Audio recording via sox + Silero VAD utterance detection.
 *
 * Records mic audio using `sox rec`, feeds through Silero VAD in-process,
 * and returns a WAV file path when a complete utterance is detected.
 *
 * Features:
 *   - Native sample rate detection + resampling to 16 kHz
 *   - Streaming preview: rolling-window WAV every N ms for partial transcription
 *   - Keyword interrupt monitor: persistent background mic during TTS
 *   - Stop/pause signal files for coordination with TTS echo suppression
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import {
  processVADChunk,
  isSpeech,
  resetVAD,
  silenceChunksForMode,
  VAD_CHUNK_SAMPLES,
} from './vad.js'
import type { SilenceMode } from '../config.js'
import {
  hasStopSignal as runtimeHasStopSignal,
  clearStopSignal as runtimeClearStopSignal,
  hasPauseSignal,
  setStopSignal,
} from '../runtime.js'

const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2

/** Seconds with no speech before giving up on hearing anything. */
const PRE_SPEECH_TIMEOUT_S = 15

// ─── Audio utilities ────────────────────────────────────────

let cachedNativeRate: number | null = null

function detectNativeSampleRate(): number {
  if (cachedNativeRate !== null) return cachedNativeRate

  try {
    const result = spawnSync('rec', ['-n', 'trim', '0', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    })
    const output = (result.stderr?.toString() ?? '') + '\n' + (result.stdout?.toString() ?? '')
    const match = output.match(/Sample Rate\s*:\s*(\d+)/)
    if (match) {
      const rate = parseInt(match[1], 10)
      if (rate > 0 && rate <= 192000) {
        cachedNativeRate = rate
        return rate
      }
    }
  } catch { /* fall through to default */ }

  cachedNativeRate = SAMPLE_RATE
  return SAMPLE_RATE
}

/** Linear interpolation resample of 16-bit PCM. */
function resamplePCM16(input: Uint8Array, fromRate: number, toRate: number): Uint8Array {
  if (fromRate === toRate) return input

  const inputView = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const inputSamples = Math.floor(input.byteLength / BYTES_PER_SAMPLE)
  if (inputSamples === 0) return new Uint8Array(0)

  const ratio = fromRate / toRate
  const outputSamples = Math.floor(inputSamples / ratio)
  const output = new Uint8Array(outputSamples * BYTES_PER_SAMPLE)
  const outputView = new DataView(output.buffer)

  for (let i = 0; i < outputSamples; i++) {
    const srcIdx = i * ratio
    const low = Math.floor(srcIdx)
    const high = Math.min(low + 1, inputSamples - 1)
    const frac = srcIdx - low
    const sampleLow = inputView.getInt16(low * BYTES_PER_SAMPLE, true)
    const sampleHigh = inputView.getInt16(high * BYTES_PER_SAMPLE, true)
    const interpolated = Math.round(sampleLow * (1 - frac) + sampleHigh * frac)
    outputView.setInt16(i * BYTES_PER_SAMPLE, interpolated, true)
  }

  return output
}

/** Create WAV file from raw 16-bit mono PCM data at 16 kHz. */
function createWavBuffer(pcmData: Uint8Array): Uint8Array {
  const byteRate = SAMPLE_RATE * 1 * 16 / 8
  const blockAlign = 1 * 16 / 8
  const dataSize = pcmData.byteLength

  const header = new ArrayBuffer(44)
  const view = new DataView(header)

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)  // PCM format
  view.setUint16(22, 1, true)  // mono
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)

  const wav = new Uint8Array(44 + dataSize)
  wav.set(new Uint8Array(header))
  wav.set(pcmData, 44)
  return wav
}

// ─── Child process tracking ─────────────────────────────────
// Track spawned child PIDs for targeted cleanup (avoid killing unrelated rec processes)

const childPids: Set<number> = new Set()

export function registerChildPid(pid: number): void {
  childPids.add(pid)
}

export function unregisterChildPid(pid: number): void {
  childPids.delete(pid)
}

export function killOwnedChildren(): void {
  for (const pid of childPids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch { /* already dead */ }
  }
  childPids.clear()
}

// ─── Stop / pause signals ───────────────────────────────────
// Now delegated to src/runtime.ts for per-run isolation.
// Uses CLAUDE_CALL_RUN_DIR env var when set, falls back to global /tmp/ paths.

function hasStopSignal(): boolean {
  return runtimeHasStopSignal()
}

function clearStopSignal(): void {
  runtimeClearStopSignal()
}

export function isPaused(): boolean {
  return hasPauseSignal()
}

/** Trigger stop signal to kill in-flight recording (e.g., when TTS starts). */
export function triggerStop(): void {
  setStopSignal()
}

// ─── Keyword interrupt monitor ──────────────────────────────

/**
 * Persistent background mic + VAD for keyword-based interrupt during TTS.
 *
 * Spawns sox once, runs VAD continuously. When a speech burst is detected,
 * extracts a rolling audio window as WAV and fires `onBurst` so the caller
 * can run fast STT and check for trigger words.
 */
export interface KeywordMonitor {
  onBurst: ((wavPath: string) => Promise<void> | void) | null
  stop(): void
}

export async function startKeywordMonitor(
  burstThreshold = 3,
  windowSeconds = 1.5,
  cooldownMs = 1500,
): Promise<KeywordMonitor> {
  await resetVAD()

  const nativeRate = detectNativeSampleRate()
  const needsResample = nativeRate !== SAMPLE_RATE
  const nativeChunkSamples = Math.ceil(VAD_CHUNK_SAMPLES * (nativeRate / SAMPLE_RATE))
  const nativeChunkBytes = nativeChunkSamples * BYTES_PER_SAMPLE

  const maxChunks = Math.ceil(windowSeconds * SAMPLE_RATE / VAD_CHUNK_SAMPLES)
  const pcmRing: Uint8Array[] = []

  let stopped = false
  let speechBurst = 0
  let checking = false
  let lastTrigger = 0
  let readBuffer = Buffer.alloc(0)

  const rec = spawn('rec', [
    '-r', String(nativeRate),
    '-c', '1', '-b', '16', '-e', 'signed',
    '-t', 'raw', '-q', '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  if (rec.pid) registerChildPid(rec.pid)

  const monitor: KeywordMonitor = {
    onBurst: null,
    stop() {
      stopped = true
      if (rec.pid) unregisterChildPid(rec.pid)
      try { rec.kill('SIGTERM') } catch { /* ignore */ }
    },
  }

  rec.stderr?.on('data', () => {}) // drain stderr

  let chain = Promise.resolve()

  rec.stdout!.on('data', (data: Buffer) => {
    if (stopped) return
    readBuffer = Buffer.concat([readBuffer, data])

    chain = chain.then(async () => {
      while (readBuffer.length >= nativeChunkBytes && !stopped) {
        const nativeChunk = new Uint8Array(readBuffer.subarray(0, nativeChunkBytes))
        readBuffer = readBuffer.subarray(nativeChunkBytes)

        const chunk = needsResample
          ? resamplePCM16(nativeChunk, nativeRate, SAMPLE_RATE)
          : nativeChunk

        pcmRing.push(chunk)
        if (pcmRing.length > maxChunks) pcmRing.shift()

        const prob = await processVADChunk(chunk)
        if (isSpeech(prob)) {
          speechBurst++
          if (
            speechBurst >= burstThreshold &&
            !checking &&
            Date.now() - lastTrigger > cooldownMs &&
            monitor.onBurst
          ) {
            checking = true
            lastTrigger = Date.now()

            // Extract rolling window as WAV
            const totalBytes = pcmRing.reduce((s, c) => s + c.byteLength, 0)
            const pcm = new Uint8Array(totalBytes)
            let offset = 0
            for (const c of pcmRing) { pcm.set(c, offset); offset += c.byteLength }
            const wavData = createWavBuffer(pcm)
            const wavPath = `/tmp/claude-call-kw-${process.pid}-${Date.now()}.wav`
            writeFileSync(wavPath, wavData)

            Promise.resolve(monitor.onBurst(wavPath))
              .catch(() => {})
              .finally(() => {
                checking = false
                try { if (existsSync(wavPath)) unlinkSync(wavPath) } catch { /* ignore */ }
              })
          }
        } else {
          speechBurst = 0
        }
      }
    }).catch(() => {})
  })

  rec.on('error', () => {})

  return monitor
}

// ─── Recording ──────────────────────────────────────────────

export interface RecordOptions {
  silenceMode?: SilenceMode
  timeoutMs?: number
  onSpeechStart?: () => void
  onSpeechEnd?: () => void
  onPreview?: (wavPath: string) => Promise<void> | void
  previewIntervalMs?: number
  previewWindowS?: number
}

/** Extract the last N seconds of PCM from a chunk list. */
function extractWindow(pcmChunks: Uint8Array[], totalPcmBytes: number, windowS: number): Uint8Array {
  const windowBytes = windowS * SAMPLE_RATE * BYTES_PER_SAMPLE
  const bytesToTake = Math.min(windowBytes, totalPcmBytes)

  const result = new Uint8Array(bytesToTake)
  let remaining = bytesToTake
  let writePos = bytesToTake

  for (let i = pcmChunks.length - 1; i >= 0 && remaining > 0; i--) {
    const chunk = pcmChunks[i]
    const take = Math.min(chunk.byteLength, remaining)
    writePos -= take
    result.set(chunk.subarray(chunk.byteLength - take), writePos)
    remaining -= take
  }

  return result
}

/**
 * Record a single utterance from the microphone.
 *
 * Spawns `sox rec`, feeds chunks through Silero VAD, and returns
 * a WAV file path when speech ends (or null on timeout / no speech / pause).
 */
export async function recordUtterance(
  options: RecordOptions = {},
): Promise<string | null> {
  const silenceMode = options.silenceMode ?? 'standard'
  const effectiveTimeout = options.timeoutMs ?? 120_000

  if (isPaused()) return null

  const silenceChunksNeeded = silenceChunksForMode(silenceMode)
  const preSpeechChunks = Math.ceil(PRE_SPEECH_TIMEOUT_S * (SAMPLE_RATE / VAD_CHUNK_SAMPLES))

  await resetVAD()
  clearStopSignal()

  const nativeRate = detectNativeSampleRate()
  const needsResample = nativeRate !== SAMPLE_RATE
  const nativeChunkSamples = Math.ceil(VAD_CHUNK_SAMPLES * (nativeRate / SAMPLE_RATE))
  const nativeChunkBytes = nativeChunkSamples * BYTES_PER_SAMPLE

  const previewIntervalMs = options.previewIntervalMs ?? 600
  const previewWindowS = options.previewWindowS ?? 5
  const onPreview = options.onPreview
  const onSpeechStart = options.onSpeechStart
  const onSpeechEnd = options.onSpeechEnd

  return new Promise<string | null>((resolve, reject) => {
    let consecutiveSilent = 0
    let totalChunks = 0
    let hasSpeechDetected = false
    let speechStartFired = false
    let speechEndFired = false
    const pcmChunks: Uint8Array[] = []
    let totalPcmBytes = 0
    let resolved = false
    let readBuffer = Buffer.alloc(0)

    let recorder: ChildProcess | null = null
    let previewInterval: ReturnType<typeof setInterval> | null = null
    let previewInFlight = false

    const stopPreview = () => {
      if (previewInterval !== null) {
        clearInterval(previewInterval)
        previewInterval = null
      }
    }

    const startPreview = () => {
      if (!onPreview || previewInterval !== null) return
      previewInterval = setInterval(() => {
        if (resolved || previewInFlight || totalPcmBytes === 0) return
        previewInFlight = true

        const windowPcm = extractWindow(pcmChunks, totalPcmBytes, previewWindowS)
        const wavData = createWavBuffer(windowPcm)
        const previewPath = `/tmp/claude-call-preview-${process.pid}-${Date.now()}.wav`
        writeFileSync(previewPath, wavData)

        Promise.resolve(onPreview(previewPath))
          .catch(() => {})
          .finally(() => { previewInFlight = false })
      }, previewIntervalMs)
    }

    const finish = (error?: Error) => {
      if (resolved) return
      resolved = true
      stopPreview()
      clearTimeout(timer)

      if (recorder && !recorder.killed) {
        if (recorder.pid) unregisterChildPid(recorder.pid)
        try { recorder.kill('SIGTERM') } catch { /* ignore */ }
        recorder = null
      }

      if (error) {
        reject(error)
        return
      }

      if (totalPcmBytes === 0 || !hasSpeechDetected) {
        resolve(null)
        return
      }

      const pcm = new Uint8Array(totalPcmBytes)
      let offset = 0
      for (const chunk of pcmChunks) {
        pcm.set(chunk, offset)
        offset += chunk.byteLength
      }

      const wavData = createWavBuffer(pcm)
      const wavPath = `/tmp/claude-call-rec-${process.pid}-${Date.now()}.wav`
      writeFileSync(wavPath, wavData)
      resolve(wavPath)
    }

    const timer = setTimeout(() => finish(), effectiveTimeout)

    try {
      recorder = spawn('rec', [
        '-r', String(nativeRate),
        '-c', '1',
        '-b', '16',
        '-e', 'signed',
        '-t', 'raw',
        '-q',
        '-',
      ], { stdio: ['ignore', 'pipe', 'pipe'] })

      if (recorder.pid) registerChildPid(recorder.pid)

      recorder.stderr?.on('data', () => {}) // drain stderr

      recorder.on('error', (err) => finish(err))

      recorder.on('close', (code) => {
        if (!resolved && code !== 0 && code !== null) {
          finish(new Error(`rec exited with code ${code}`))
        }
      })

      let processingChain = Promise.resolve()

      recorder.stdout!.on('data', (data: Buffer) => {
        if (resolved) return

        readBuffer = Buffer.concat([readBuffer, data])

        processingChain = processingChain.then(async () => {
          while (readBuffer.length >= nativeChunkBytes && !resolved) {
            const nativeChunk = new Uint8Array(readBuffer.subarray(0, nativeChunkBytes))
            readBuffer = readBuffer.subarray(nativeChunkBytes)

            const chunk = needsResample
              ? resamplePCM16(nativeChunk, nativeRate, SAMPLE_RATE)
              : nativeChunk

            pcmChunks.push(chunk)
            totalPcmBytes += chunk.byteLength
            totalChunks++

            const speechProb = await processVADChunk(chunk)
            const speechDetected = isSpeech(speechProb)

            if (speechDetected) {
              if (!hasSpeechDetected) {
                hasSpeechDetected = true
                if (!speechStartFired && onSpeechStart) {
                  speechStartFired = true
                  onSpeechStart()
                }
                startPreview()
              }
              consecutiveSilent = 0
            } else {
              consecutiveSilent++
            }

            if (hasStopSignal()) {
              clearStopSignal()
              // Fire onSpeechEnd if speech was detected — stop signal
              // kills recording before natural silence detection can fire it.
              if (hasSpeechDetected && !speechEndFired && onSpeechEnd) {
                speechEndFired = true
                onSpeechEnd()
              }
              finish()
              return
            }

            if (hasSpeechDetected && consecutiveSilent >= silenceChunksNeeded) {
              if (!speechEndFired && onSpeechEnd) {
                speechEndFired = true
                onSpeechEnd()
              }
              finish()
              return
            }

            if (!hasSpeechDetected && totalChunks >= preSpeechChunks) {
              finish()
              return
            }
          }
        }).catch((err: unknown) => {
          finish(err instanceof Error ? err : new Error(String(err)))
        })
      })
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

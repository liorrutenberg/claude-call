/**
 * Silero VAD (Voice Activity Detection) — ONNX inference in Node.js.
 *
 * Uses Silero VAD v5 ONNX model (~2.3 MB, <1% CPU on Apple Silicon).
 * Chunk size: 512 samples (32ms at 16 kHz).
 * The ONNX model requires a 64-sample context window prepended to each chunk.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { getModelsDir } from '../config.js'
import type { SilenceMode } from '../config.js'

// onnxruntime-node uses a native C++ addon (N-API) and must be loaded via require()
const require_ = createRequire(import.meta.url)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ort: any = require_('onnxruntime-node')

// ─── Constants ──────────────────────────────────────────────

/** VAD chunk size — 512 samples = 32ms at 16 kHz. Silero VAD v5 requirement. */
export const VAD_CHUNK_SAMPLES = 512
export const VAD_CHUNK_BYTES = VAD_CHUNK_SAMPLES * 2 // 16-bit = 2 bytes per sample

/** Context size for Silero VAD ONNX model (64 samples). */
const VAD_CONTEXT_SAMPLES = 64

/** Speech probability threshold. Above = speech, below = silence. */
const SPEECH_THRESHOLD = 0.3

/** How long VAD must report "no speech" before stopping. */
const SILENCE_MODE_SECONDS: Record<SilenceMode, number> = {
  quick: 1.0,
  standard: 1.5,
  thoughtful: 2.5,
}

const CHUNKS_PER_SECOND = 16000 / VAD_CHUNK_SAMPLES // ~31.25

export function silenceChunksForMode(mode: SilenceMode): number {
  return Math.ceil(SILENCE_MODE_SECONDS[mode] * CHUNKS_PER_SECOND)
}

// ─── Model path ─────────────────────────────────────────────

function findModelPath(): string {
  const modelPath = `${getModelsDir()}/silero_vad.onnx`
  if (existsSync(modelPath)) return modelPath

  throw new Error(
    `Silero VAD model not found at: ${modelPath}\n` +
    'Run "claude-call setup" to download required models.'
  )
}

// ─── VAD Session ────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
interface VADSession {
  session: any
  state: any
  sr: any
  context: Float32Array
}

let cachedSession: VADSession | null = null

export async function initVAD(): Promise<void> {
  if (cachedSession) return

  const modelPath = findModelPath()
  const session = await ort.InferenceSession.create(modelPath)

  const state = new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128])
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(16000)]), [])
  const context = new Float32Array(VAD_CONTEXT_SAMPLES)

  cachedSession = { session, state, sr, context }
}

/**
 * Process a single chunk of 16-bit PCM audio through Silero VAD.
 * @param pcmChunk - Exactly VAD_CHUNK_BYTES (1024) bytes of 16-bit signed PCM
 * @returns Speech probability (0.0 - 1.0)
 */
export async function processVADChunk(pcmChunk: Uint8Array): Promise<number> {
  if (!cachedSession) await initVAD()
  const vad = cachedSession!

  // Convert 16-bit signed PCM to float32 [-1, 1]
  const view = new DataView(pcmChunk.buffer, pcmChunk.byteOffset, pcmChunk.byteLength)
  const audioFloats = new Float32Array(VAD_CHUNK_SAMPLES)
  for (let i = 0; i < VAD_CHUNK_SAMPLES; i++) {
    audioFloats[i] = view.getInt16(i * 2, true) / 32768.0
  }

  // Prepend context (64) + audio (512) = 576 samples
  const totalSamples = VAD_CONTEXT_SAMPLES + VAD_CHUNK_SAMPLES
  const padded = new Float32Array(totalSamples)
  padded.set(vad.context, 0)
  padded.set(audioFloats, VAD_CONTEXT_SAMPLES)

  const input = new ort.Tensor('float32', padded, [1, totalSamples])

  const result = await vad.session.run({
    input,
    state: vad.state,
    sr: vad.sr,
  })

  vad.state = result.stateN
  vad.context = padded.slice(padded.length - VAD_CONTEXT_SAMPLES)

  return result.output.data[0] as number
}

export function isSpeech(probability: number): boolean {
  return probability >= SPEECH_THRESHOLD
}

export async function resetVAD(): Promise<void> {
  if (cachedSession) {
    cachedSession.state = new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128])
    cachedSession.context = new Float32Array(VAD_CONTEXT_SAMPLES)
  }
}

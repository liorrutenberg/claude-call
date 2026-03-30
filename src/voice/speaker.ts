/**
 * Speaker verification using sherpa-onnx speaker embeddings.
 *
 * Enrollment: user records 3+ samples -> averaged embedding -> saved as JSON profile.
 * Verification: compute embedding of new audio -> cosine similarity against profile.
 *
 * Gracefully degrades if sherpa-onnx-node is not installed or model not downloaded.
 * When unavailable, all checks pass through (never blocks voice).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { loadConfig } from '../config.js'

// ─── Types ──────────────────────────────────────────────────

interface SpeakerProfile {
  embedding: number[]
  enrolledAt: string
  sampleCount: number
}

// ─── State ──────────────────────────────────────────────────

let extractor: any = null  // eslint-disable-line @typescript-eslint/no-explicit-any
let profile: SpeakerProfile | null = null
let sherpaAvailable: boolean | null = null

// ─── Helpers ────────────────────────────────────────────────

function getProfilePath(): string {
  return join(loadConfig().dataDir, 'voice-profile.json')
}

function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

// ─── Initialization ─────────────────────────────────────────

/**
 * Try to load sherpa-onnx-node. Returns false if not installed.
 */
async function ensureSherpa(): Promise<boolean> {
  if (sherpaAvailable !== null) return sherpaAvailable
  try {
    const sherpaModule = await import(/* webpackIgnore: true */ 'sherpa-onnx-node' as string)
    // Handle CJS→ESM interop: exports live on .default for CommonJS modules
    const sherpa = sherpaModule.default ?? sherpaModule
    // Verify the model file exists
    const config = loadConfig()
    if (!existsSync(config.speaker.modelPath)) {
      sherpaAvailable = false
      return false
    }
    extractor = new sherpa.SpeakerEmbeddingExtractor({
      model: config.speaker.modelPath,
      numThreads: 1,
      debug: false,
    })
    sherpaAvailable = true
    return true
  } catch {
    sherpaAvailable = false
    return false
  }
}

/**
 * Load saved voice profile from disk.
 */
function loadProfile(): SpeakerProfile | null {
  if (profile) return profile
  const path = getProfilePath()
  if (!existsSync(path)) return null
  try {
    profile = JSON.parse(readFileSync(path, 'utf-8')) as SpeakerProfile
    return profile
  } catch {
    return null
  }
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Check if speaker verification is available and configured.
 */
export async function isSpeakerVerificationReady(): Promise<boolean> {
  const config = loadConfig()
  if (!config.speaker.enabled) return false
  if (!(await ensureSherpa())) return false
  return loadProfile() !== null
}

/**
 * Extract speaker embedding from a WAV file.
 */
export async function extractEmbedding(wavPath: string): Promise<Float32Array | null> {
  if (!(await ensureSherpa()) || !extractor) return null

  const sherpaModule = await import(/* webpackIgnore: true */ 'sherpa-onnx-node' as string)
  const { readWave } = sherpaModule.default ?? sherpaModule
  const wave = readWave(wavPath)

  const stream = extractor.createStream()
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples })
  stream.inputFinished()

  if (!extractor.isReady(stream)) return null
  return extractor.compute(stream) as Float32Array
}

/**
 * Verify if a WAV file matches the enrolled speaker.
 * Returns true if speaker matches or verification is not configured.
 */
export async function verifySpeaker(wavPath: string): Promise<boolean> {
  const config = loadConfig()
  if (!config.speaker.enabled) return true  // not enabled = pass through

  if (!(await ensureSherpa())) return true  // sherpa not available = pass through

  const savedProfile = loadProfile()
  if (!savedProfile) return true  // no profile enrolled = pass through

  const embedding = await extractEmbedding(wavPath)
  if (!embedding) return true  // extraction failed = pass through (don't block)

  const similarity = cosineSimilarity(embedding, savedProfile.embedding)
  return similarity >= config.speaker.threshold
}

/**
 * Enroll a speaker from multiple WAV samples.
 * Averages embeddings and saves to disk.
 */
export async function enrollSpeaker(wavPaths: string[]): Promise<{ success: boolean; error?: string }> {
  if (!(await ensureSherpa())) {
    return { success: false, error: 'sherpa-onnx-node not available. Run: npm install sherpa-onnx-node' }
  }

  const embeddings: Float32Array[] = []
  for (const wavPath of wavPaths) {
    const embedding = await extractEmbedding(wavPath)
    if (!embedding) {
      return { success: false, error: `Failed to extract embedding from ${wavPath}` }
    }
    embeddings.push(embedding)
  }

  if (embeddings.length === 0) {
    return { success: false, error: 'No valid embeddings extracted' }
  }

  // Average all embeddings
  const dim = embeddings[0].length
  const averaged = new Float32Array(dim)
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      averaged[i] += emb[i]
    }
  }
  for (let i = 0; i < dim; i++) {
    averaged[i] /= embeddings.length
  }

  // Normalize
  let norm = 0
  for (let i = 0; i < dim; i++) norm += averaged[i] * averaged[i]
  norm = Math.sqrt(norm)
  for (let i = 0; i < dim; i++) averaged[i] /= norm

  const newProfile: SpeakerProfile = {
    embedding: Array.from(averaged),
    enrolledAt: new Date().toISOString(),
    sampleCount: embeddings.length,
  }

  const profilePath = getProfilePath()
  mkdirSync(dirname(profilePath), { recursive: true })
  writeFileSync(profilePath, JSON.stringify(newProfile, null, 2))

  // Update cache
  profile = newProfile

  return { success: true }
}

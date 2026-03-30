/**
 * Volume gate — RMS amplitude computation for 16-bit signed PCM audio.
 *
 * Used to reject quiet audio (background noise picked up by VAD)
 * before sending to Whisper for transcription.
 */

import { readFileSync } from 'node:fs'

/**
 * Compute RMS amplitude of 16-bit signed PCM audio.
 * Returns value in [0, 1] range.
 */
export function computeRMS(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const numSamples = pcm.byteLength / 2
  if (numSamples === 0) return 0

  let sumSquares = 0
  for (let i = 0; i < numSamples; i++) {
    const sample = view.getInt16(i * 2, true) / 32768.0
    sumSquares += sample * sample
  }
  return Math.sqrt(sumSquares / numSamples)
}

/**
 * Compute RMS amplitude from a WAV file (16-bit signed PCM).
 * Returns value in [0, 1] range.
 */
export function computeRmsFromWav(wavPath: string): number {
  const data = readFileSync(wavPath)
  // Skip 44-byte WAV header
  const pcm = new Uint8Array(data.buffer, data.byteOffset + 44, data.byteLength - 44)
  return computeRMS(pcm)
}

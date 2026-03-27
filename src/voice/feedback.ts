/**
 * Audio feedback cues for call session state.
 *
 * Uses sox `play` command to generate tones — no external sound files needed.
 * Separate from TTS playback (has its own process tracking).
 *
 * Three sounds:
 *   - Start/resume chime: short ascending tone when call activates or unpauses
 *   - Pause chime: short descending tone when call pauses
 *   - Thinking pulse: gentle repeating tick while waiting for Claude's response
 */

import { spawn } from 'node:child_process'
import { loadConfig } from '../config.js'

// ─── Active process tracking ─────────────────────────────────

let thinkingInterval: NodeJS.Timeout | null = null
let thinkingTimeout: NodeJS.Timeout | null = null
let thinkingMaxTimeout: NodeJS.Timeout | null = null // Safety cutoff

// ─── Helpers ─────────────────────────────────────────────────

function isEnabled(): boolean {
  return loadConfig().feedback.enabled
}

function getVolume(): number {
  return loadConfig().feedback.volume
}

/**
 * Play a tone without waiting (fire and forget).
 */
function playToneAsync(args: string[]): void {
  if (!isEnabled()) return

  const proc = spawn('play', args, { stdio: 'ignore' })
  // Don't track single-shot chimes — they're short enough
  proc.once('error', () => {})
}

// ─── Start/Resume Chime ──────────────────────────────────────

/**
 * Play start/resume chime — short ascending tone.
 * Two quick notes: 600Hz then 800Hz.
 */
export function playStartChime(): void {
  const vol = getVolume()
  // Two-tone ascending chime (colon chains synth commands)
  playToneAsync([
    '-n', '-q',
    'synth', '0.08', 'sine', '600', ':',
    'synth', '0.08', 'sine', '800',
    'vol', String(vol),
    'fade', 'q', '0.01', '-0', '0.01',
  ])
}

// ─── Pause Chime ─────────────────────────────────────────────

/**
 * Play pause chime — short descending tone.
 * Two quick notes: 800Hz then 500Hz.
 */
export function playPauseChime(): void {
  const vol = getVolume()
  // Two-tone descending chime (colon chains synth commands)
  playToneAsync([
    '-n', '-q',
    'synth', '0.08', 'sine', '800', ':',
    'synth', '0.12', 'sine', '500',
    'vol', String(vol),
    'fade', 'q', '0.01', '-0', '0.02',
  ])
}

// ─── Thinking Pulse ──────────────────────────────────────────

/**
 * Play a single thinking tick — very soft, short click.
 */
function playThinkingTick(): void {
  const vol = getVolume() * 0.5 // Even quieter than chimes
  playToneAsync([
    '-n', '-q',
    'synth', '0.05', 'sine', '440',
    'vol', String(vol),
    'fade', 'q', '0.01', '-0', '0.02',
  ])
}

/**
 * Start the thinking pulse after a 500ms delay.
 * Repeats a gentle tick every 1.5 seconds until stopped.
 * Auto-stops after 60 seconds as a safety cutoff.
 */
export function startThinkingPulse(): void {
  if (!isEnabled()) return
  stopThinkingPulse() // Clear any existing

  thinkingTimeout = setTimeout(() => {
    // Play first tick
    playThinkingTick()
    // Then repeat every 1.5s
    thinkingInterval = setInterval(playThinkingTick, 1500)
  }, 500)

  // Safety cutoff: stop after 60 seconds if never explicitly stopped
  thinkingMaxTimeout = setTimeout(stopThinkingPulse, 60_000)
}

/**
 * Stop the thinking pulse immediately.
 */
export function stopThinkingPulse(): void {
  if (thinkingTimeout) {
    clearTimeout(thinkingTimeout)
    thinkingTimeout = null
  }
  if (thinkingInterval) {
    clearInterval(thinkingInterval)
    thinkingInterval = null
  }
  if (thinkingMaxTimeout) {
    clearTimeout(thinkingMaxTimeout)
    thinkingMaxTimeout = null
  }
}

// ─── Cleanup ─────────────────────────────────────────────────

/**
 * Stop all feedback sounds.
 */
export function stopAllFeedback(): void {
  stopThinkingPulse()
}

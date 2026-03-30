/**
 * Audio feedback cues for call session state.
 *
 * Uses sox `play` command to generate tones — no external sound files needed.
 * Separate from TTS playback (has its own process tracking).
 *
 * Three sounds:
 *   - Start/unmute chime: short ascending tone when call activates or unmutes
 *   - Mute chime: short descending tone when call mutes
 *   - Thinking pulse: gentle repeating tick while waiting for Claude's response
 */

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { loadConfig, getLogDir } from '../config.js'

// ─── Logging ─────────────────────────────────────────────────

let logFile: string | null = null

function getLogFile(): string {
  if (!logFile) {
    const dir = getLogDir()
    mkdirSync(dir, { recursive: true })
    logFile = `${dir}/channel.log`
  }
  return logFile
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [feedback] ${msg}\n`
  process.stderr.write(line)
  try { appendFileSync(getLogFile(), line) } catch { /* ignore */ }
}

// ─── Active process tracking ─────────────────────────────────

let thinkingTimeout: NodeJS.Timeout | null = null
let thinkingMaxTimeout: NodeJS.Timeout | null = null // Safety cutoff
let pulseGeneration = 0 // Monotonic counter — incremented on every start/stop to kill orphaned callbacks

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
function playToneAsync(args: string[], label: string): void {
  if (!isEnabled()) return

  log(`${label}`)
  const proc = spawn('play', args, { stdio: 'ignore' })
  // Don't track single-shot chimes — they're short enough
  proc.once('error', (err) => log(`play error (${label}): ${err.message}`))
}

// ─── Start/Unmute Chime ──────────────────────────────────────

/**
 * Play start/unmute chime — short ascending tone.
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
  ], 'start chime')
}

// ─── Mute Chime ──────────────────────────────────────────────

/**
 * Play mute chime — short descending tone.
 * Two quick notes: 800Hz then 500Hz.
 */
export function playMuteChime(): void {
  const vol = getVolume()
  // Two-tone descending chime (colon chains synth commands)
  playToneAsync([
    '-n', '-q',
    'synth', '0.08', 'sine', '800', ':',
    'synth', '0.12', 'sine', '500',
    'vol', String(vol),
    'fade', 'q', '0.01', '-0', '0.02',
  ], 'mute chime')
}

// ─── Speech Detection Beeps ─────────────────────────────────

/**
 * Play a short high beep when VAD detects speech start.
 * Single quick tick — confirms mic is capturing.
 */
export function playSpeechStartBeep(): void {
  const vol = getVolume() * 0.5
  playToneAsync([
    '-n', '-q',
    'synth', '0.06', 'sine', '880',
    'vol', String(vol),
    'fade', 'q', '0.01', '-0', '0.01',
  ], 'speech start beep')
}

/**
 * Play a short low beep when VAD detects speech end.
 * Single quick tick — confirms utterance was captured.
 */
export function playSpeechEndBeep(): void {
  const vol = getVolume() * 0.5
  playToneAsync([
    '-n', '-q',
    'synth', '0.06', 'sine', '660',
    'vol', String(vol),
    'fade', 'q', '0.01', '-0', '0.01',
  ], 'speech end beep')
}

// ─── Thinking Pulse ──────────────────────────────────────────

/**
 * Play a single thinking tick — very soft, short click.
 */
function playThinkingTick(): void {
  const vol = getVolume() * 0.6 // Softer than chimes but clearly audible
  playToneAsync([
    '-n', '-q',
    'synth', '0.05', 'sine', '440',
    'vol', String(vol),
    'fade', 'q', '0.01', '-0', '0.02',
  ], 'thinking tick')
}

/**
 * Start the thinking pulse after a 500ms delay.
 * Uses recursive setTimeout tied to a generation token — each start/stop
 * increments the generation, instantly orphaning any pending callbacks
 * from a previous pulse without relying on clearInterval timing.
 * Auto-stops after 60 seconds as a safety cutoff.
 */
export function startThinkingPulse(): void {
  if (!isEnabled()) return
  stopThinkingPulse() // Clear any existing + bump generation

  const gen = ++pulseGeneration // Capture token for this pulse

  function scheduleNextTick(): void {
    thinkingTimeout = setTimeout(() => {
      if (gen !== pulseGeneration) return // Orphaned — silently die
      playThinkingTick()
      scheduleNextTick()
    }, 1500)
  }

  log('thinking pulse started')
  // Initial delay before first tick
  thinkingTimeout = setTimeout(() => {
    if (gen !== pulseGeneration) return // Orphaned
    playThinkingTick()
    scheduleNextTick()
  }, 500)

  // Safety cutoff: stop after 60 seconds if never explicitly stopped
  thinkingMaxTimeout = setTimeout(() => {
    if (gen !== pulseGeneration) return // Stale safety timeout — ignore
    stopThinkingPulse()
  }, 60_000)
}

/**
 * Stop the thinking pulse immediately.
 * Increments pulseGeneration so any pending recursive setTimeout callbacks
 * will see a stale generation token and silently exit.
 */
export function stopThinkingPulse(): void {
  const wasActive = thinkingTimeout !== null
  pulseGeneration++ // Kill switch — orphan any pending callbacks
  if (thinkingTimeout) {
    clearTimeout(thinkingTimeout)
    thinkingTimeout = null
  }
  if (thinkingMaxTimeout) {
    clearTimeout(thinkingMaxTimeout)
    thinkingMaxTimeout = null
  }
  if (wasActive) {
    log('thinking pulse stopped')
  }
}

// ─── Cleanup ─────────────────────────────────────────────────

/**
 * Stop all feedback sounds.
 */
export function stopAllFeedback(): void {
  stopThinkingPulse()
}

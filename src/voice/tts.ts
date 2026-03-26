/**
 * Text-to-speech with 4-tier cascade:
 *   1. Piper TTS (local, fast, ~100ms)
 *   2. Qwen3-TTS daemon (localhost:8880, best quality, fully local)
 *   3. edge-tts (Microsoft neural voices, free, good quality)
 *   4. macOS say (always works, robotic but reliable)
 *
 * Long text is split into sentences and pipelined: synthesize next chunk
 * while playing current, so the user hears audio faster.
 */

import { existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { applyPronunciation } from './pronunciation.js'
import { loadConfig } from '../config.js'

// ─── Active playback tracking ───────────────────────────────

let activePlayback: ChildProcess | null = null

// ─── Piper TTS ──────────────────────────────────────────────

function findPiper(): string | null {
  const paths = ['/opt/homebrew/bin/piper', '/usr/local/bin/piper']
  for (const p of paths) {
    if (existsSync(p)) return p
  }
  return null
}

function synthesizePiper(text: string, outPath: string): Promise<boolean> {
  const config = loadConfig()
  const bin = findPiper()
  if (!bin) return Promise.resolve(false)
  if (!existsSync(config.tts.piperModel)) return Promise.resolve(false)

  return new Promise((resolve) => {
    const proc = spawn(bin, [
      '--model', config.tts.piperModel,
      '--output-file', outPath,
      '--length-scale', '0.95',
      '--noise-scale', '0.6',
      '--noise-w', '0.7',
      '--sentence-silence', '0.15',
    ], { stdio: ['pipe', 'ignore', 'ignore'] })

    proc.stdin?.write(text)
    proc.stdin?.end()

    proc.once('close', (code) => resolve(code === 0))
    proc.once('error', () => resolve(false))
  })
}

// ─── Qwen3-TTS daemon ───────────────────────────────────────

async function isQwen3Available(): Promise<boolean> {
  const config = loadConfig()
  const url = config.tts.qwen3Url
  if (!url) return false

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)
    const res = await fetch(`${url}/health`, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return false
    const data = (await res.json()) as { status: string; model_loaded: boolean }
    return data.status === 'ok' && data.model_loaded === true
  } catch {
    return false
  }
}

async function synthesizeQwen3(text: string): Promise<Buffer | null> {
  const config = loadConfig()
  const url = config.tts.qwen3Url

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    const res = await fetch(`${url}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) return null
    const data = (await res.json()) as { audio_b64: string }
    return Buffer.from(data.audio_b64, 'base64')
  } catch {
    return null
  }
}

// ─── edge-tts ───────────────────────────────────────────────

function findEdgeTts(): string | null {
  const paths = ['/opt/homebrew/bin/edge-tts', '/usr/local/bin/edge-tts']
  for (const p of paths) {
    if (existsSync(p)) return p
  }
  // Try PATH
  return 'edge-tts'
}

function synthesizeEdgeTts(text: string, outPath: string): Promise<boolean> {
  const config = loadConfig()
  const bin = findEdgeTts()!

  return new Promise((resolve) => {
    const proc = spawn(bin, [
      '--text', text,
      '--voice', config.tts.voice,
      '--rate', '+15%',
      '--write-media', outPath,
    ], { stdio: 'ignore' })

    proc.once('close', (code) => resolve(code === 0))
    proc.once('error', () => resolve(false))
  })
}

// ─── Playback ───────────────────────────────────────────────

let ttsCounter = 0

function playAudio(filePath: string): Promise<void> {
  const config = loadConfig()
  return new Promise((resolve) => {
    const proc = spawn('afplay', ['-r', String(config.tts.rate), filePath], { stdio: 'ignore' })
    activePlayback = proc
    proc.once('close', () => {
      activePlayback = null
      try { unlinkSync(filePath) } catch { /* file may already be gone */ }
      resolve()
    })
    proc.once('error', () => {
      activePlayback = null
      try { unlinkSync(filePath) } catch { /* file may already be gone */ }
      resolve()
    })
  })
}

function playSay(text: string, rate = '220'): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn('say', ['-r', rate, text], { stdio: 'ignore' })
    activePlayback = proc
    proc.once('close', () => { activePlayback = null; resolve() })
    proc.once('error', () => { activePlayback = null; resolve() })
  })
}

// ─── Sentence chunking ─────────────────────────────────────

function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+/)
  return parts.map(s => s.trim()).filter(s => s.length > 0)
}

// ─── Synthesis dispatch ─────────────────────────────────────

async function synthesizeToFile(text: string): Promise<string | null> {
  const config = loadConfig()
  const engine = config.tts.engine

  // Tier 1: Piper (if auto or explicitly chosen)
  if (engine === 'auto' || engine === 'piper') {
    const tmpFile = `/tmp/claude-call-tts-${process.pid}-${ttsCounter++}.wav`
    if (await synthesizePiper(text, tmpFile) && existsSync(tmpFile)) return tmpFile
    if (engine === 'piper') return null // explicit choice, don't cascade
  }

  // Tier 2: Qwen3-TTS daemon
  if (engine === 'auto' || engine === 'qwen3') {
    if (await isQwen3Available()) {
      const audio = await synthesizeQwen3(text)
      if (audio) {
        const tmpFile = `/tmp/claude-call-tts-${process.pid}-${ttsCounter++}.wav`
        writeFileSync(tmpFile, audio)
        return tmpFile
      }
    }
    if (engine === 'qwen3') return null
  }

  // Tier 3: edge-tts
  if (engine === 'auto' || engine === 'edge-tts') {
    const tmpFile = `/tmp/claude-call-tts-${process.pid}-${ttsCounter++}.mp3`
    if (await synthesizeEdgeTts(text, tmpFile) && existsSync(tmpFile)) return tmpFile
    if (engine === 'edge-tts') return null
  }

  // Tier 4: say fallback (handled in speak() — no file needed)
  return null
}

// ─── Public API ─────────────────────────────────────────────

export interface SpeakOptions {
  onMute?: () => void
  onUnmute?: () => void
  /** Return true to stop speaking (user wants to interrupt). */
  onInterruptCheck?: () => Promise<boolean>
}

/**
 * Speak text aloud using the best available TTS engine.
 * Long text is split into sentences and pipelined for fast first-audio.
 * Calls onMute before playback starts and onUnmute after it ends.
 */
export async function speak(text: string, opts?: SpeakOptions): Promise<void> {
  if (!text?.trim()) return

  text = applyPronunciation(text)
  const sentences = splitSentences(text)

  opts?.onMute?.()

  try {
    if (sentences.length <= 1) {
      const file = await synthesizeToFile(text)
      if (file) {
        await playAudio(file)
      } else {
        await playSay(text)
      }
      return
    }

    // Pipeline: synthesize next sentence while playing current
    let nextSynth: Promise<string | null> = synthesizeToFile(sentences[0])

    for (let i = 0; i < sentences.length; i++) {
      const file = await nextSynth

      // Start synthesizing next sentence while current one plays
      if (i + 1 < sentences.length) {
        nextSynth = synthesizeToFile(sentences[i + 1])
      }

      // Check for interrupt before playback
      if (opts?.onInterruptCheck && await opts.onInterruptCheck()) {
        if (file) try { unlinkSync(file) } catch { /* ignore */ }
        if (i + 1 < sentences.length) {
          nextSynth.then(f => { if (f) try { unlinkSync(f) } catch { /* ignore */ } }).catch(() => {})
        }
        break
      }

      if (file) {
        await playAudio(file)
      } else {
        await playSay(sentences[i])
      }

      // Check for interrupt after playback
      if (i + 1 < sentences.length && opts?.onInterruptCheck) {
        if (await opts.onInterruptCheck()) {
          nextSynth.then(f => { if (f) try { unlinkSync(f) } catch { /* ignore */ } }).catch(() => {})
          break
        }
      }
    }
  } finally {
    // Brief delay before unmuting so mic doesn't catch tail-end audio
    await new Promise(r => setTimeout(r, 300))
    opts?.onUnmute?.()
  }
}

/**
 * Stop any in-progress TTS playback (kills afplay/say processes).
 */
export function stopSpeaking(): void {
  if (activePlayback && !activePlayback.killed) {
    try { activePlayback.kill('SIGTERM') } catch { /* ignore */ }
    activePlayback = null
  }
}

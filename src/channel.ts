#!/usr/bin/env node
/**
 * Voice channel for Claude Code.
 *
 * MCP channel server that provides continuous two-way voice I/O:
 *   - Silero VAD (ONNX) + sox for speech detection
 *   - Whisper STT (server + CLI) for transcription
 *   - TTS cascade (Piper → edge-tts → say) with sentence pipelining
 *   - Echo suppression: mutes recording during TTS playback
 *   - Keyword interrupt: detects "stop"/"mute" mid-speech to kill playback
 *   - Streaming partial transcription via rolling-window previews
 *
 * Launch: claude --mcp-config ~/.claude-call/mcp.json
 */

// Low-level Server needed for channel protocol (custom notifications, experimental capabilities)
// McpServer is the high-level API but doesn't support channels directly
import { Server } from '@modelcontextprotocol/sdk/server/index.js' // eslint-disable-line deprecation/deprecation
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { existsSync, unlinkSync, appendFileSync, mkdirSync, openSync, writeSync, closeSync, constants } from 'node:fs'
import { join } from 'node:path'

import { loadConfig, getLogDir } from './config.js'
import { initVAD } from './voice/vad.js'
import { transcribe, transcribeFast, getModelPath } from './voice/stt.js'
import { speak as ttsSpeak, stopSpeaking } from './voice/tts.js'
import {
  recordUtterance,
  isMuted,
  triggerStop,
  startKeywordMonitor,
  killOwnedChildren,
} from './voice/recorder.js'
import {
  playStartChime,
  playMuteChime,
  playSpeechStartBeep,
  playSpeechEndBeep,
  startThinkingPulse,
  stopThinkingPulse,
} from './voice/feedback.js'
import type { RecordOptions } from './voice/recorder.js'
import { applySttCorrections } from './voice/pronunciation.js'
import { getRunDirFromEnv, getFifoPath, updateStatus, setMuteSignalIn, clearMuteSignalIn } from './runtime.js'

// ─── Junk transcript filter ────────────────────────────────

const JUNK_TRANSCRIPTS = new Set([
  '', 'you', 'thank you', 'thanks', 'thanks for watching',
  'thank you for watching', 'sorry, i hid', 'sorry i hid',
  'sorry, i hit', 'sorry i hit',
  // Filler sounds (not commands or meaningful speech)
  'hmm', 'huh', 'uh', 'um', 'ah',
])

// ─── Logging ────────────────────────────────────────────────

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
  const line = `[${new Date().toISOString()}] [voice] ${msg}\n`
  process.stderr.write(line)
  try { appendFileSync(getLogFile(), line) } catch { /* ignore */ }
}

// ─── Helpers ────────────────────────────────────────────────

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function isMeaningful(text: string): boolean {
  const t = normalizeText(text).toLowerCase().replace(/[.,!?;:]+$/g, '')
  if (!t || t.length < 2) return false
  if (JUNK_TRANSCRIPTS.has(t)) return false

  // Check for repetitive words (Whisper hallucination pattern)
  const words = t.split(/\s+/)
  if (words.length >= 3) {
    const firstWord = words[0]
    if (words.every(w => w === firstWord)) return false
  }

  return true
}

// ─── Soft mute ──────────────────────────────────────────────

const MUTE_PHRASES = ['exo mute', 'echo mute', 'exo mewt', 'echo mewt']
const UNMUTE_PHRASES = ['exo unmute', 'echo unmute', 'exo start', 'echo start', 'exo on mute', 'echo on mute']

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[-,.:;!?]/g, ' ').replace(/\s+/g, ' ').trim()
}

function matchesMute(text: string): boolean {
  const t = normalizeForMatch(text)
  return MUTE_PHRASES.some(p => t.includes(p))
}

function matchesUnmute(text: string): boolean {
  const t = normalizeForMatch(text)
  return UNMUTE_PHRASES.some(p => t.includes(p))
}

// ─── Wake word filter (dual mode) ────────────────────────────

const WAKE_PREFIXES = ['exo ', 'echo ', 'exel ', 'exo, ', 'echo, ', 'exo. ', 'echo. ']

/**
 * Extract the text after the wake word prefix.
 * Returns null if no wake word found, or the stripped text if found.
 */
function extractAfterWakeWord(text: string): string | null {
  const t = normalizeForMatch(text)
  for (const prefix of WAKE_PREFIXES) {
    if (t.startsWith(prefix)) {
      // Find position in original text and strip
      const idx = text.toLowerCase().indexOf(prefix.trimEnd())
      if (idx >= 0) {
        return text.slice(idx + prefix.trimEnd().length).trim()
      }
    }
  }
  return null
}

/**
 * Block the voice loop while user-muted, keeping mic alive via keyword monitor.
 * Resolves when "exo unmute" / "exo start" is detected.
 */
async function waitForUnmute(): Promise<void> {
  log('user muted — listening for unmute keyword...')

  const kwMonitor = await startKeywordMonitor(3, 1.5, 500)

  return new Promise<void>((resolve) => {
    kwMonitor.onBurst = async (wavPath: string) => {
      try {
        const raw = normalizeText(await transcribeFast(wavPath)).toLowerCase()
        log(`unmute check: "${raw}"`)
        if (matchesUnmute(raw)) {
          log('unmuted by voice command')
          const runDir = getRunDirFromEnv()
          if (runDir) {
            clearMuteSignalIn(runDir)
            updateStatus(runDir, { status: 'running' })
          }
          kwMonitor.stop()
          resolve()
        }
      } catch (err) {
        log(`unmute transcription error: ${(err as Error).message}`)
      }
    }

    // Also exit if externally unmuted (CLI or TUI cleared the signal file)
    const check = setInterval(() => {
      if (!isMuted()) {
        clearInterval(check)
        kwMonitor.stop()
        resolve()
      }
    }, 500)
  })
}

// ─── State ──────────────────────────────────────────────────

let ttsMuted = false
let voiceLoopRunning = false
let sessionDead = false

// Speech queue — serializes concurrent speak calls, prevents overlapping audio
let speakQueue: Promise<void> = Promise.resolve()
let speakGeneration = 0  // Cancel token for queue flushing

function flushSpeakQueue(): void {
  speakGeneration++
}

// ─── FIFO state (call mode) ─────────────────────────────────

let fifoFd: number | null = null
let fifoPath: string | null = null

function openFifo(): number | null {
  const runDir = getRunDirFromEnv()
  if (!runDir) return null

  fifoPath = getFifoPath(runDir)

  try {
    // O_WRONLY | O_NONBLOCK: don't block if no reader
    const fd = openSync(fifoPath, constants.O_WRONLY | constants.O_NONBLOCK)
    log(`opened FIFO: ${fifoPath}`)
    return fd
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      log(`FIFO not found: ${fifoPath}`)
    } else if (code === 'ENXIO') {
      log(`FIFO has no reader: ${fifoPath}`)
    } else {
      log(`FIFO open error: ${code}`)
    }
    return null
  }
}

function closeFifo(): void {
  if (fifoFd !== null) {
    try {
      closeSync(fifoFd)
    } catch { /* ignore */ }
    fifoFd = null
    log('closed FIFO')
  }
}

function writeFifo(data: string): boolean {
  // Lazy open on first write
  if (fifoFd === null) {
    fifoFd = openFifo()
    if (fifoFd === null) return false
  }

  try {
    writeSync(fifoFd, data)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPIPE') {
      log('FIFO broken pipe — Claude session has exited')
      sessionDead = true
      // Update status to crashed so CLI can detect
      const runDir = getRunDirFromEnv()
      if (runDir) {
        updateStatus(runDir, { status: 'crashed' })
        log('status updated to crashed')
      }
    } else if (code === 'EAGAIN') {
      log('FIFO would block')
    } else {
      log(`FIFO write error: ${code}`)
    }
    // Close and reopen on next attempt
    closeFifo()
    return false
  }
}

// ─── MCP Channel Server ────────────────────────────────────

const mcp = new Server(
  { name: 'voice', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      'Voice messages from the user\'s microphone arrive as <channel source="voice">.',
      'These are transcribed speech — treat them as the user talking to you.',
      'Reply using the speak tool so the user hears your response.',
      'Summarize your answer when speaking. For detailed or complex responses, speak the summary and write the full answer as text in the session.',
      'No markdown, no bullet points, no code blocks in spoken replies.',
      'You may use Read for one quick file lookup per request. For anything else (Write, Edit, Bash, Grep, searches, multi-step work), dispatch a background agent.',
      'If the user also types in the terminal, respond normally in text (don\'t call speak for typed messages).',
      'CALL MODE: Never make the user wait. Offload work to background agents. Dispatch with run_in_background: true and keep talking.',
      'Answer only from immediate context or profile knowledge directly. Everything else gets an agent.',
      'When a background agent completes, surface the result naturally in conversation.',
    ].join(' '),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'speak',
      description: 'Speak text aloud to the user via text-to-speech. Use this to reply to voice channel messages.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string' as const, description: 'The text to speak aloud' },
        },
        required: ['text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  if (req.params.name === 'speak') {
    const text = (args.text as string) ?? ''
    if (!text) return { content: [{ type: 'text', text: 'spoken' }] }

    const gen = speakGeneration
    const result = await new Promise<string>((resolve) => {
      const task = async () => {
        try {
          // Check if cancelled (queue was flushed since we enqueued)
          if (gen !== speakGeneration) {
            resolve('cancelled')
            return
          }
          // Check if muted (signal file — unified source of truth)
          if (isMuted()) {
            resolve('muted')
            return
          }

          const speakStart = Date.now()
          stopThinkingPulse() // Stop thinking pulse when response begins
          log(`speaking: ${text}`)

          const config = loadConfig()
          const interruptKeywords = config.interrupt.keywords
          let interrupted = false
          let tFirstAudio = 0
          const kwMonitor = await startKeywordMonitor(3, 1.5, 500)

          kwMonitor.onBurst = async (wavPath: string) => {
            try {
              const raw = normalizeText(await transcribeFast(wavPath)).toLowerCase()
              log(`keyword check: "${raw}"`)
              if (interruptKeywords.some(kw => raw.includes(kw))) {
                interrupted = true
                stopSpeaking()
                flushSpeakQueue() // Cancel all pending speak items
                log(`keyword interrupt: "${raw}"`)
              }
            } catch (err) {
              log(`keyword transcription error: ${(err as Error).message}`)
            }
          }

          try {
            await ttsSpeak(text, {
              onMute: () => {
                ttsMuted = true
                triggerStop()
                log('tts muted (speaking)')
              },
              onUnmute: () => {
                ttsMuted = false
                log('tts unmuted (done speaking)')
              },
              onInterruptCheck: async () => interrupted,
              onFirstAudio: () => {
                tFirstAudio = Date.now()
              },
            })
          } finally {
            kwMonitor.stop()
            const speakFinish = Date.now()
            if (tFirstAudio) {
              log(`speak: tts_first=${tFirstAudio - speakStart}ms tts_total=${speakFinish - speakStart}ms`)
            } else {
              log(`speak: tts_total=${speakFinish - speakStart}ms`)
            }
          }

          resolve('spoken')
        } catch (err) {
          log(`speak queue task error: ${(err as Error).message}`)
          resolve('error')
        }
      }
      speakQueue = speakQueue.then(task, task)
    })

    return { content: [{ type: 'text', text: result }] }
  }

  return {
    content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
    isError: true,
  }
})

// ─── Deliver voice to Claude Code session ───────────────────

async function deliver(text: string): Promise<void> {
  log(`delivering: ${text}`)

  const runDir = getRunDirFromEnv()
  if (!runDir) {
    log('ERROR: No run dir available (CLAUDE_CALL_RUN_DIR not set)')
    return
  }

  const msg = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: `<channel source="voice">${text}</channel>` }],
    },
  }
  const json = JSON.stringify(msg) + '\n'
  if (writeFifo(json)) {
    log('delivered via FIFO')
  } else {
    log('FIFO delivery failed')
  }
}

// ─── Voice loop ─────────────────────────────────────────────

async function voiceLoop(): Promise<void> {
  if (voiceLoopRunning) {
    log('voice loop already running — skipping duplicate start')
    return
  }
  voiceLoopRunning = true

  log('loading Silero VAD model...')
  await initVAD()
  log('VAD model loaded')

  try {
    const modelPath = getModelPath()
    log(`whisper model: ${modelPath}`)
  } catch (err) {
    log(`whisper model error: ${(err as Error).message}`)
    return
  }

  const config = loadConfig()
  log(`config: silence=${config.silence.mode}, tts=${config.tts.engine}, rate=${config.tts.rate}`)
  log('starting voice loop')

  // Play start chime when voice loop begins
  playStartChime()

  while (true) {
    if (sessionDead) {
      log('session dead, exiting voice loop')
      return
    }

    try {
      if (ttsMuted) {
        await new Promise(r => setTimeout(r, 100))
        continue
      }

      if (isMuted()) {
        await waitForUnmute()
        if (isMuted()) continue // still muted somehow
        playStartChime()
        log('voice loop resumed from mute')
        await deliver('[Voice unmuted]')
        continue
      }

      let partialText = ''
      let stableText = ''

      const recordOpts: RecordOptions = {
        silenceMode: config.silence.mode,
        onSpeechStart: () => {
          log('speech detected — listening...')
          stopThinkingPulse() // User speaking means Claude responded (or user interrupted) — kill any lingering pulse
          playSpeechStartBeep()
          partialText = ''
          stableText = ''
        },
        onSpeechEnd: () => {
          log('speech ended — captured')
          playSpeechEndBeep()
        },
        previewIntervalMs: 600,
        previewWindowS: 5,
        onPreview: async (previewWav: string) => {
          try {
            const t0 = Date.now()
            const raw = normalizeText(await transcribeFast(previewWav))
            const dt = Date.now() - t0

            if (!raw) return

            const words = raw.split(' ')
            const newStable = words.length > 5 ? words.slice(0, -5).join(' ') : ''
            const unstable = words.length > 5 ? words.slice(-5).join(' ') : raw

            if (newStable.length > stableText.length) {
              stableText = newStable
            }
            partialText = stableText + (stableText ? ' ' : '') + unstable

            log(`partial (${dt}ms): "${partialText}"`)
          } catch (err) {
            log(`preview transcription error: ${(err as Error).message}`)
          } finally {
            try { if (existsSync(previewWav)) unlinkSync(previewWav) } catch { /* ignore */ }
          }
        },
      }

      const t0 = Date.now()
      const wavPath = await recordUtterance(recordOpts)
      const t1 = Date.now()

      if (!wavPath) continue

      log(`recording took ${t1 - t0}ms`)

      if (ttsMuted) {
        try { unlinkSync(wavPath) } catch { /* ignore */ }
        continue
      }

      log(`transcribing (full): ${wavPath}`)
      let text: string
      let t2: number, t3: number
      try {
        t2 = Date.now()
        text = applySttCorrections(normalizeText(await transcribe(wavPath)))
        t3 = Date.now()
        log(`transcription took ${t3 - t2}ms: "${text}"`)
      } catch (err) {
        log(`transcription error: ${(err as Error).message}`)
        continue
      } finally {
        try { if (existsSync(wavPath)) unlinkSync(wavPath) } catch { /* ignore */ }
      }

      if (!text || !isMeaningful(text)) {
        log(`filtered: "${text}"`)
        continue
      }

      if (ttsMuted) {
        log(`dropped (tts muted): "${text}"`)
        continue
      }

      // Soft mute trigger — "exo mute" keeps mic alive but stops processing
      // Must check BEFORE wake word stripping so "exo mute" matches
      if (matchesMute(text)) {
        playMuteChime()
        log(`mute triggered: "${text}"`)
        const muteRunDir = getRunDirFromEnv()
        if (muteRunDir) {
          setMuteSignalIn(muteRunDir)
          updateStatus(muteRunDir, { status: 'muted' })
        }
        try {
          await deliver('[Voice muted — say "exo unmute" to unmute]')
        } catch { /* ignore */ }
        continue
      }

      // Wake word filter in dual mode — require "exo" prefix
      // Applied after mute check so "exo mute" still works
      // Check both config AND runtime signal file (prefix file in run dir enables it)
      const runDirForPrefix = getRunDirFromEnv()
      const prefixEnabled = runDirForPrefix
        ? (existsSync(join(runDirForPrefix, 'prefix')) ||
           (config.wakeWord.enabled && !existsSync(join(runDirForPrefix, 'no-prefix'))))
        : config.wakeWord.enabled
      if (runDirForPrefix && prefixEnabled) {
        const stripped = extractAfterWakeWord(text)
        if (!stripped) {
          log(`filtered (no wake word): "${text}"`)
          continue
        }
        text = stripped
      }

      log(`heard: ${text}`)

      try {
        await deliver(text)
        const tDelivered = Date.now()
        log('delivered')
        log(`pipeline: record=${t1 - t0}ms stt=${t3 - t2}ms deliver=${tDelivered - t3}ms total=${tDelivered - t0}ms`)
        // Start thinking pulse while waiting for Claude's response
        startThinkingPulse()
      } catch (err) {
        log(`deliver error: ${(err as Error).message}`)
      }
    } catch (err) {
      log(`error: ${(err as Error).message}`)
      await new Promise(r => setTimeout(r, 1000))
    }
  }
}

// ─── Cleanup owned children ─────────────────────────────────

let cleanedUp = false

function cleanupOnExit(): void {
  if (cleanedUp) return
  cleanedUp = true
  killOwnedChildren()
  closeFifo()
}

// ─── Main ───────────────────────────────────────────────────

let mainStarted = false

async function main(): Promise<void> {
  if (mainStarted) {
    log('main already started — skipping duplicate initialization')
    return
  }
  mainStarted = true

  // Clean shutdown handlers
  process.on('SIGTERM', () => {
    log('received SIGTERM — cleaning up')
    cleanupOnExit()
    process.exit(0)
  })

  process.on('SIGINT', () => {
    log('received SIGINT — cleaning up')
    cleanupOnExit()
    process.exit(0)
  })

  process.on('exit', () => {
    cleanupOnExit()
  })

  await mcp.connect(new StdioServerTransport())
  log('connected to Claude Code')

  voiceLoop().catch((err) => {
    log(`voice loop fatal: ${(err as Error).message}`)
  })
}

main().catch((err) => {
  process.stderr.write(`[voice] fatal: ${err}\n`)
  process.exit(1)
})

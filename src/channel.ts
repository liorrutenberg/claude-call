#!/usr/bin/env node
/**
 * Voice channel for Claude Code.
 *
 * MCP channel server that provides continuous two-way voice I/O:
 *   - Silero VAD (ONNX) + sox for speech detection
 *   - Whisper STT (server + CLI) for transcription
 *   - TTS cascade (Piper → edge-tts → say) with sentence pipelining
 *   - Echo suppression: mutes recording during TTS playback
 *   - Keyword interrupt: detects "stop"/"wait" mid-speech to kill playback
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
import { existsSync, unlinkSync, appendFileSync, mkdirSync } from 'node:fs'

import { loadConfig, getLogDir } from './config.js'
import { initVAD } from './voice/vad.js'
import { transcribe, transcribeFast, getModelPath } from './voice/stt.js'
import { speak as ttsSpeak, stopSpeaking } from './voice/tts.js'
import {
  recordUtterance,
  isPaused,
  triggerStop,
  startKeywordMonitor,
} from './voice/recorder.js'
import type { RecordOptions } from './voice/recorder.js'

// ─── Junk transcript filter ────────────────────────────────

const JUNK_TRANSCRIPTS = new Set([
  '', 'you', 'thank you', 'thanks', 'thanks for watching',
  'thank you for watching', 'sorry, i hid', 'sorry i hid',
  'sorry, i hit', 'sorry i hit',
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
  return !JUNK_TRANSCRIPTS.has(t)
}

// ─── State ──────────────────────────────────────────────────

let muted = false

// ─── MCP Channel Server ────────────────────────────────────

const mcp = new Server(
  { name: 'voice', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'Voice messages from the user\'s microphone arrive as <channel source="voice">.',
      'These are transcribed speech — treat them as the user talking to you.',
      'Reply using the speak tool so the user hears your response.',
      'Keep spoken replies to 1-3 SHORT sentences. Natural spoken language only.',
      'No markdown, no bullet points, no code blocks in spoken replies.',
      'You can still use tools (Read, Write, Bash, etc.) before replying — just make sure to call speak with the final answer.',
      'If the user also types in the terminal, respond normally in text (don\'t call speak for typed messages).',
      'CALL MODE: Never make the user wait. If work is needed (lookups, searches, multi-step research), dispatch a background Agent and keep talking.',
      'Offload heavy work to background agents with run_in_background: true. Answer simple questions directly.',
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
    if (text) {
      log(`speaking: ${text}`)

      const config = loadConfig()
      const interruptKeywords = config.interrupt.keywords
      let interrupted = false
      const kwMonitor = await startKeywordMonitor(3, 1.5, 1500)

      kwMonitor.onBurst = async (wavPath: string) => {
        try {
          const raw = normalizeText(await transcribeFast(wavPath)).toLowerCase()
          log(`keyword check: "${raw}"`)
          if (interruptKeywords.some(kw => raw.includes(kw))) {
            interrupted = true
            stopSpeaking()
            log(`keyword interrupt: "${raw}"`)
          }
        } catch (err) {
          log(`keyword transcription error: ${(err as Error).message}`)
        }
      }

      try {
        await ttsSpeak(text, {
          onMute: () => {
            muted = true
            triggerStop()
            log('muted (speaking)')
          },
          onUnmute: () => {
            muted = false
            log('unmuted (done speaking)')
          },
          onInterruptCheck: async () => interrupted,
        })
      } finally {
        kwMonitor.stop()
      }
    }
    return { content: [{ type: 'text', text: 'spoken' }] }
  }

  return {
    content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
    isError: true,
  }
})

// ─── Deliver voice to Claude Code session ───────────────────

async function deliver(text: string): Promise<void> {
  log(`delivering: ${text}`)
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: { ts: new Date().toISOString() },
    },
  })
}

// ─── Voice loop ─────────────────────────────────────────────

async function voiceLoop(): Promise<void> {
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

  while (true) {
    try {
      if (muted) {
        await new Promise(r => setTimeout(r, 100))
        continue
      }

      if (isPaused()) {
        await new Promise(r => setTimeout(r, 500))
        continue
      }

      let partialText = ''
      let stableText = ''

      const recordOpts: RecordOptions = {
        silenceMode: config.silence.mode,
        onSpeechStart: () => {
          log('speech detected — listening...')
          partialText = ''
          stableText = ''
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

      if (muted) {
        try { unlinkSync(wavPath) } catch { /* ignore */ }
        continue
      }

      log(`transcribing (full): ${wavPath}`)
      let text: string
      try {
        const t2 = Date.now()
        text = normalizeText(await transcribe(wavPath))
        const t3 = Date.now()
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

      if (muted) {
        log(`dropped (muted): "${text}"`)
        continue
      }

      log(`heard: ${text}`)

      try {
        await deliver(text)
        log('delivered')
      } catch (err) {
        log(`deliver error: ${(err as Error).message}`)
      }
    } catch (err) {
      log(`error: ${(err as Error).message}`)
      await new Promise(r => setTimeout(r, 1000))
    }
  }
}

// ─── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
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

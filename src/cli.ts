#!/usr/bin/env node
/**
 * CLI entry point for claude-call.
 *
 * Commands:
 *   setup  — Interactive first-run setup (deps, models, config)
 *   check  — Verify everything works
 *   serve  — Start the MCP channel server (used by Claude Code, not humans)
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { stringify as stringifyYaml } from 'yaml'
import { loadConfig } from './config.js'
import { checkDeps, formatDepsReport } from './setup/deps.js'
import { MODELS, downloadWithProgress, isModelDownloaded } from './setup/models.js'

const VERSION = '0.1.0'

// ─── Helpers ────────────────────────────────────────────────

function writeln(msg = ''): void {
  process.stderr.write(msg + '\n')
}

async function ask(prompt: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const suffix = defaultValue ? ` [${defaultValue}]` : ''
  return new Promise((resolve) => {
    rl.question(`${prompt}${suffix}: `, (answer) => {
      rl.close()
      resolve(answer.trim() || defaultValue || '')
    })
  })
}

async function confirm(prompt: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]'
  const answer = await ask(`${prompt} ${hint}`)
  if (!answer) return defaultYes
  return answer.toLowerCase().startsWith('y')
}

// ─── Setup command ──────────────────────────────────────────

async function setup(): Promise<void> {
  writeln()
  writeln('\x1b[1mclaude-call setup\x1b[0m  v' + VERSION)
  writeln('Continuous two-way voice conversations for Claude Code')
  writeln()

  // Step 1: Check system dependencies
  writeln('\x1b[1m1. Checking system dependencies...\x1b[0m')
  writeln()
  const deps = checkDeps()
  writeln(formatDepsReport(deps))
  writeln()

  const missingRequired = deps.filter(d => d.required && !d.found)
  if (missingRequired.length > 0) {
    writeln('\x1b[31mMissing required dependencies. Install them and re-run setup.\x1b[0m')
    process.exit(1)
  }

  const hasWhisper = deps.find(d => d.name === 'whisper-cli')?.found ?? false

  // Step 2: Download models
  writeln('\x1b[1m2. Downloading models...\x1b[0m')
  writeln()

  // VAD model — always required
  await downloadWithProgress(MODELS.vad)

  // Whisper model selection
  let whisperSize = 'base'
  if (hasWhisper || await confirm('Download a Whisper STT model for speech-to-text?')) {
    writeln()
    writeln('  Whisper model sizes:')
    writeln('    1. base    (~141 MB) — fast, good enough for most use')
    writeln('    2. large   (~1.5 GB) — best accuracy, needs more RAM')
    writeln()
    const choice = await ask('  Choose model size', '1')
    whisperSize = choice === '2' ? 'large' : 'base'
    const modelKey = whisperSize === 'large' ? 'whisper-large' : 'whisper-base'
    writeln()
    await downloadWithProgress(MODELS[modelKey])
  }
  writeln()

  // Piper model — optional
  const hasPiper = deps.find(d => d.name === 'piper')?.found ?? false
  if (hasPiper && !isModelDownloaded('piper-voice')) {
    if (await confirm('Download Piper voice model for fast local TTS?')) {
      writeln()
      await downloadWithProgress(MODELS['piper-voice'])
      await downloadWithProgress(MODELS['piper-voice-config'])
    }
    writeln()
  }

  // Step 3: Write config
  writeln('\x1b[1m3. Writing configuration...\x1b[0m')
  writeln()

  const config = loadConfig()
  const configDir = config.dataDir
  mkdirSync(configDir, { recursive: true })

  const configPath = join(configDir, 'config.yaml')
  if (existsSync(configPath)) {
    if (!await confirm(`  Config exists at ${configPath}. Overwrite?`, false)) {
      writeln('  Keeping existing config.')
    } else {
      writeConfigFile(configPath, whisperSize)
    }
  } else {
    writeConfigFile(configPath, whisperSize)
  }

  // Step 4: Write MCP config
  const mcpPath = join(configDir, 'mcp.json')
  writeMcpConfig(mcpPath)
  writeln()

  // Step 5: Next steps
  writeln('\x1b[1m4. Setup complete!\x1b[0m')
  writeln()
  writeln('  To use with Claude Code, add to your project \x1b[1m.mcp.json\x1b[0m:')
  writeln()
  writeln('  {')
  writeln('    "mcpServers": {')
  writeln('      "voice": {')
  writeln('        "command": "npx",')
  writeln('        "args": ["claude-call", "serve"]')
  writeln('      }')
  writeln('    }')
  writeln('  }')
  writeln()
  writeln('  Or launch directly:')
  writeln(`    claude --mcp-config ${mcpPath}`)
  writeln()
  writeln('  Then enable the development channel:')
  writeln('    claude --dangerously-load-development-channels server:voice')
  writeln()
}

function writeConfigFile(path: string, whisperSize: string): void {
  const config = {
    tts: {
      engine: 'auto' as const,
      rate: 1.25,
    },
    stt: {
      modelSize: whisperSize,
    },
    silence: {
      mode: 'quick' as const,
    },
    interrupt: {
      keywords: ['stop', 'wait', 'hold on', 'pause', 'hey'],
    },
  }

  writeFileSync(path, stringifyYaml(config))
  writeln(`  Config written to ${path}`)
}

function writeMcpConfig(path: string): void {
  const config = {
    mcpServers: {
      voice: {
        command: 'npx',
        args: ['claude-call', 'serve'],
      },
    },
  }

  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
  writeln(`  MCP config written to ${path}`)
}

// ─── Check command ──────────────────────────────────────────

async function check(): Promise<void> {
  writeln()
  writeln('\x1b[1mclaude-call check\x1b[0m')
  writeln()

  writeln('Dependencies:')
  const deps = checkDeps()
  writeln(formatDepsReport(deps))
  writeln()

  writeln('Models:')
  const models = ['vad', 'whisper-base', 'whisper-large', 'piper-voice']
  for (const key of models) {
    const model = MODELS[key]
    const status = isModelDownloaded(key) ? '\x1b[32m found\x1b[0m' : '\x1b[33m not found\x1b[0m'
    writeln(`  ${status}  ${model.name} (${model.filename})`)
  }
  writeln()

  writeln('Config:')
  const config = loadConfig()
  const configPath = join(config.dataDir, 'config.yaml')
  writeln(`  Data dir: ${config.dataDir}`)
  writeln(`  Config:   ${existsSync(configPath) ? configPath : 'using defaults'}`)
  writeln(`  TTS:      ${config.tts.engine} @ ${config.tts.rate}x`)
  writeln(`  Silence:  ${config.silence.mode}`)
  writeln()

  const allGood = deps.filter(d => d.required).every(d => d.found) && isModelDownloaded('vad')
  if (allGood) {
    writeln('\x1b[32mReady to use.\x1b[0m')
  } else {
    writeln('\x1b[31mSome requirements are missing. Run "claude-call setup" to fix.\x1b[0m')
  }
  writeln()
}

// ─── Serve command ──────────────────────────────────────────

async function serve(): Promise<void> {
  // Dynamically import the channel to start the MCP server
  await import('./channel.js')
}

// ─── Main ───────────────────────────────────────────────────

const command = process.argv[2]

switch (command) {
  case 'setup':
    setup().catch((err) => {
      writeln(`\nSetup failed: ${(err as Error).message}`)
      process.exit(1)
    })
    break

  case 'check':
    check().catch((err) => {
      writeln(`\nCheck failed: ${(err as Error).message}`)
      process.exit(1)
    })
    break

  case 'serve':
    serve().catch((err) => {
      process.stderr.write(`[voice] fatal: ${err}\n`)
      process.exit(1)
    })
    break

  default:
    writeln()
    writeln(`\x1b[1mclaude-call\x1b[0m v${VERSION}`)
    writeln('Continuous two-way voice conversations for Claude Code')
    writeln()
    writeln('Commands:')
    writeln('  setup   Interactive first-run setup')
    writeln('  check   Verify dependencies and models')
    writeln('  serve   Start MCP channel server (used by Claude Code)')
    writeln()
    writeln('Quick start:')
    writeln('  npx claude-call setup')
    writeln()
    break
}

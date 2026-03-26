#!/usr/bin/env node
/**
 * CLI entry point for claude-call.
 *
 * Commands:
 *   setup  — Interactive first-run setup (deps, models, config)
 *   check  — Verify everything works
 *   serve  — Start the MCP channel server (used by Claude Code, not humans)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
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

/**
 * Detect the project root by walking up from cwd looking for .git or package.json.
 * Returns null if no project root is found.
 */
function findProjectRoot(): string | null {
  let dir = process.cwd()
  const root = '/'
  while (dir !== root) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'package.json'))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Add voice server entry to a project's .mcp.json.
 * Creates the file if it doesn't exist, merges if it does.
 */
function writeProjectMcpJson(projectRoot: string): void {
  const mcpPath = join(projectRoot, '.mcp.json')
  let existing: Record<string, unknown> = {}

  if (existsSync(mcpPath)) {
    try {
      existing = JSON.parse(readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>
    } catch {
      existing = {}
    }
  }

  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>
  servers.voice = {
    command: 'npx',
    args: ['claude-call', 'serve'],
  }
  existing.mcpServers = servers

  writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n')
  writeln(`  Voice server added to ${mcpPath}`)
}

/**
 * Create .claude/commands/call-start.md and call-stop.md in the project.
 */
function writeCommandFiles(projectRoot: string): void {
  const commandsDir = join(projectRoot, '.claude', 'commands')
  mkdirSync(commandsDir, { recursive: true })

  const callStart = `Resume the voice channel by removing the pause file, then confirm voice is active.

\`\`\`bash
rm -f /tmp/claude-call-pause
\`\`\`

Say "Call mode. I'm here — what's on your mind?" using the speak tool.
`

  const callStop = `Pause the voice channel by creating the pause file, then confirm voice is paused.

\`\`\`bash
touch /tmp/claude-call-pause
\`\`\`

Respond with "Voice paused." (text only, don't use speak tool since we just muted).
`

  const startPath = join(commandsDir, 'call-start.md')
  const stopPath = join(commandsDir, 'call-stop.md')

  writeFileSync(startPath, callStart)
  writeln(`  Created ${startPath}`)

  writeFileSync(stopPath, callStop)
  writeln(`  Created ${stopPath}`)
}

// ─── Setup command ──────────────────────────────────────────

async function setup(): Promise<void> {
  writeln()
  writeln('\x1b[1mclaude-call setup\x1b[0m  v' + VERSION)
  writeln('Continuous two-way voice conversations for Claude Code')
  writeln()

  // Step 1: Check system dependencies
  writeln('\x1b[1m1. Checking dependencies...\x1b[0m')
  writeln()
  const deps = checkDeps()
  writeln(formatDepsReport(deps))
  writeln()

  const missingRequired = deps.filter(d => d.required && !d.found)
  if (missingRequired.length > 0) {
    writeln('\x1b[31mMissing required dependencies. Install them and re-run setup.\x1b[0m')
    process.exit(1)
  }

  // Step 2: Download models (VAD + whisper-large-v3-turbo + Piper voice)
  writeln('\x1b[1m2. Downloading models...\x1b[0m')
  writeln()

  await downloadWithProgress(MODELS.vad)

  // Whisper model — default to large-v3-turbo for accuracy
  writeln()
  writeln('  Whisper model sizes:')
  writeln('    1. large   (~1.5 GB) — best accuracy (recommended)')
  writeln('    2. base    (~141 MB) — faster, lower accuracy')
  writeln()
  const whisperChoice = await ask('  Choose model size', '1')
  const whisperSize = whisperChoice === '2' ? 'base' : 'large'
  const whisperModelKey = whisperSize === 'large' ? 'whisper-large' : 'whisper-base'
  writeln()
  await downloadWithProgress(MODELS[whisperModelKey])

  // Piper voice model
  writeln()
  await downloadWithProgress(MODELS['piper-voice'])
  await downloadWithProgress(MODELS['piper-voice-config'])
  writeln()

  // Step 3: Write global config
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
  writeln()

  // Step 4: Add to project .mcp.json + create command files
  writeln('\x1b[1m4. Project integration...\x1b[0m')
  writeln()

  const projectRoot = findProjectRoot()
  if (projectRoot) {
    writeln(`  Detected project: ${projectRoot}`)
    writeProjectMcpJson(projectRoot)
    writeCommandFiles(projectRoot)
  } else {
    writeln('  No project root detected (no .git or package.json found).')
    if (await confirm('  Add to current directory?', false)) {
      const cwd = process.cwd()
      writeProjectMcpJson(cwd)
      writeCommandFiles(cwd)
    } else {
      writeln('  Skipping project integration. You can manually add to .mcp.json later.')
    }
  }
  writeln()

  // Step 5: Done
  writeln('\x1b[1m5. Setup complete!\x1b[0m')
  writeln()
  writeln('  Done. Start Claude Code and say \x1b[1m/call-start\x1b[0m')
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

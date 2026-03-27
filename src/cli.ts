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
import { join, dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { execSync, spawn } from 'node:child_process'
import { stringify as stringifyYaml } from 'yaml'
import { loadConfig, getModelsDir } from './config.js'
import { checkDeps, formatDepsReport, installMissing } from './setup/deps.js'
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
 * Find a binary in PATH. Returns the full path or null.
 */
function findBinaryInPath(name: string): string | null {
  try {
    return execSync(`which ${name}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null
  } catch {
    return null
  }
}

/**
 * Check whisper-server health endpoint.
 */
async function checkWhisperHealth(): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)
    const res = await fetch('http://127.0.0.1:8178/health', { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return false
    const data = (await res.json()) as { status?: string }
    return data.status === 'ok'
  } catch {
    return false
  }
}

/**
 * Wait for whisper-server health check to pass, polling every 500ms.
 */
async function waitForWhisperHealth(timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await checkWhisperHealth()) return true
    await new Promise(r => setTimeout(r, 500))
  }
  return false
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
    command: 'claude-call',
    args: ['serve'],
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

  // Step 1: Check and install dependencies
  writeln('\x1b[1m1. Checking dependencies...\x1b[0m')
  writeln()
  const deps = checkDeps()
  writeln(formatDepsReport(deps))
  writeln()

  const missing = deps.filter(d => !d.found)
  if (missing.length > 0) {
    writeln('  Installing missing dependencies...')
    writeln()
    const failed = installMissing(deps)
    if (failed.length > 0) {
      writeln()
      writeln('\x1b[31mFailed to install: ' + failed.map(d => d.name).join(', ') + '\x1b[0m')
      writeln('Install manually and re-run setup.')
      process.exit(1)
    }
    writeln()
  }

  // Step 2: Download models (VAD + whisper-large-v3-turbo + Piper voice)
  writeln('\x1b[1m2. Downloading models...\x1b[0m')
  writeln()

  await downloadWithProgress(MODELS.vad)
  writeln()

  // Whisper model — large-v3-turbo by default, offer base as fallback
  let whisperSize = 'large'
  if (!await confirm('  Download whisper-large-v3-turbo (1.5 GB)?')) {
    whisperSize = 'base'
  }
  const whisperModelKey = whisperSize === 'large' ? 'whisper-large' : 'whisper-base'
  await downloadWithProgress(MODELS[whisperModelKey])
  writeln()

  // Piper voice model
  await downloadWithProgress(MODELS['piper-voice'])
  await downloadWithProgress(MODELS['piper-voice-config'])
  writeln()

  // Step 2b: Start whisper-server if available
  writeln('\x1b[1m   Starting whisper-server...\x1b[0m')
  writeln()

  let whisperServerStarted = false
  const whisperServerBinary = findBinaryInPath('whisper-server')
  const whisperModelFile = join(getModelsDir(), whisperSize === 'large' ? 'ggml-large-v3-turbo.bin' : 'ggml-base.bin')

  if (whisperServerBinary) {
    if (existsSync(whisperModelFile)) {
      try {
        // Check if whisper-server is already running on this port
        const alreadyRunning = await checkWhisperHealth()
        if (alreadyRunning) {
          writeln('  whisper-server already running on 127.0.0.1:8178')
          whisperServerStarted = true
        } else {
          const serverProc = spawn(whisperServerBinary, [
            '-m', whisperModelFile,
            '--port', '8178',
            '--host', '127.0.0.1',
            '-t', '4',
            '-nt',
            '--convert',
          ], {
            stdio: 'ignore',
            detached: true,
          })
          serverProc.unref()

          // Wait up to 5 seconds for health check
          whisperServerStarted = await waitForWhisperHealth(5000)
          if (whisperServerStarted) {
            writeln(`  \x1b[32mwhisper-server started\x1b[0m (pid ${serverProc.pid}, port 8178)`)
          } else {
            writeln('  \x1b[33mwhisper-server started but health check timed out\x1b[0m')
            writeln('  It may still be loading the model. The server will be available shortly.')
          }
        }
      } catch (err) {
        writeln(`  \x1b[33mFailed to start whisper-server: ${(err as Error).message}\x1b[0m`)
      }
    } else {
      writeln(`  \x1b[33mWhisper model not found at ${whisperModelFile} — skipping server start\x1b[0m`)
    }
  } else {
    writeln('  \x1b[2mwhisper-server not found (optional, from whisper-cpp brew package) — skipping\x1b[0m')
  }
  writeln()

  // Step 3: Project integration
  writeln('\x1b[1m3. Project integration...\x1b[0m')
  writeln()

  let effectiveProjectRoot: string | null = null
  const projectRoot = findProjectRoot()
  if (projectRoot) {
    writeln(`  Detected project: ${projectRoot}`)
    writeProjectMcpJson(projectRoot)
    writeCommandFiles(projectRoot)
    effectiveProjectRoot = projectRoot
  } else {
    writeln('  No project root detected (no .git or package.json found).')
    if (await confirm('  Add to current directory?', false)) {
      const cwd = process.cwd()
      writeProjectMcpJson(cwd)
      writeCommandFiles(cwd)
      effectiveProjectRoot = cwd
    } else {
      writeln('  Skipping project integration. You can manually add to .mcp.json later.')
    }
  }

  // Look for pronunciation.yaml in the project directory
  let pronunciationFile: string | undefined
  if (effectiveProjectRoot) {
    const pronunciationPaths = [
      join(effectiveProjectRoot, 'data', 'integrations', 'voice', 'pronunciation.yaml'),
      join(effectiveProjectRoot, 'pronunciation.yaml'),
      join(effectiveProjectRoot, 'config', 'pronunciation.yaml'),
    ]
    for (const p of pronunciationPaths) {
      if (existsSync(p)) {
        pronunciationFile = resolve(p)
        writeln(`  Found pronunciation dictionary: ${pronunciationFile}`)
        break
      }
    }
  }
  writeln()

  // Step 4: Write global config
  writeln('\x1b[1m4. Writing configuration...\x1b[0m')
  writeln()

  const config = loadConfig()
  const configDir = config.dataDir
  mkdirSync(configDir, { recursive: true })

  const configPath = join(configDir, 'config.yaml')
  if (existsSync(configPath)) {
    if (!await confirm(`  Config exists at ${configPath}. Overwrite?`, false)) {
      writeln('  Keeping existing config.')
    } else {
      writeConfigFile(configPath, whisperSize, pronunciationFile)
    }
  } else {
    writeConfigFile(configPath, whisperSize, pronunciationFile)
  }
  writeln()

  // Step 5: Done
  writeln('\x1b[1m5. Setup complete!\x1b[0m')
  writeln()
  writeln('  Launch Claude Code with voice:')
  writeln()
  writeln('    \x1b[1mclaude --dangerously-load-development-channels server:voice\x1b[0m')
  writeln()
  writeln('  Then say \x1b[1m/call-start\x1b[0m to begin talking.')
  writeln()
  writeln('  \x1b[2mTo add voice to another project, run "claude-call setup" from that directory.\x1b[0m')
  writeln()
}

function writeConfigFile(configPath: string, whisperSize: string, pronunciationFile?: string): void {
  const config: Record<string, unknown> = {
    tts: {
      engine: 'auto' as const,
      rate: 1.25,
    },
    stt: {
      modelSize: whisperSize,
      serverUrl: 'http://127.0.0.1:8178',
    },
    silence: {
      mode: 'quick' as const,
    },
    interrupt: {
      keywords: ['stop', 'step', 'wait', 'hold on', 'pause', 'hey'],
    },
  }

  if (pronunciationFile) {
    config.pronunciation = { file: pronunciationFile }
  }

  writeFileSync(configPath, stringifyYaml(config))
  writeln(`  Config written to ${configPath}`)
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

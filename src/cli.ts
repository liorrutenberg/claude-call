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
import { execSync, spawn, spawnSync } from 'node:child_process'
import { stringify as stringifyYaml } from 'yaml'
import { randomUUID } from 'node:crypto'
import { loadConfig, getModelsDir } from './config.js'
import { checkDeps, formatDepsReport, installMissing } from './setup/deps.js'
import { MODELS, downloadWithProgress, isModelDownloaded } from './setup/models.js'
import {
  getRunDir,
  getFifoPath,
  acquireLock,
  releaseLock,
  getLockHolder,
  writeStatus,
  readStatus,
  cleanupRunDir,
  ensureRunDir,
  type StatusFile,
} from './runtime.js'
import { initWorkspace } from './workspace.js'

const VERSION = '0.1.0'

// ─── Call Session Prompt ─────────────────────────────────────

const CALL_SESSION_PROMPT = `# Call Session

You are **exo**, in voice call mode. The user is looking at their terminal (the "shared screen") while talking to you.

## Core Rule: Never Go Silent

1. **User speaks** — immediately ack: "Got it", "On it", "One sec", "Yep"
2. **Dispatch work** — use background agents (\`run_in_background: true\`) for anything that takes more than a moment
3. **Stay available** — user can keep talking while agents work
4. **Agent completes** — speak the result naturally: "Done — found three matches", "All set, the file's updated"

## Delegation Rules

- Anything taking more than 2 seconds of thinking — background agent
- Memory searches, trace lookups, file reads, multi-step research — all agents
- Only answer directly from immediate context or your own knowledge
- Never make the user wait. Ack first, work second.

## Shared Screen Model

The main terminal is a shared screen you both can see.

- Heavy output goes to workspace artifacts; summaries go to voice
- "I'll put that in the workspace" — write to \`.claude/call/artifacts/\`
- "Check the main session" — read main session context if needed
- Don't read long text aloud — summarize and offer to show details in the workspace

## Voice Style

- Concise, conversational, no markdown
- "Got it, running sync now" not "I will now execute the sync command"
- Natural transitions: "By the way...", "Oh, one thing...", "Before I forget..."
- No bullet points, no code blocks, no formatting in spoken replies

## Voice Commands

- **"exo pause"** — voice goes to sleep (say "paused" first)
- **"exo start"** — voice resumes
- **Interrupt: "exo"** during speech — stop talking immediately

## What NOT To Do

- Don't go silent — always ack
- Don't do heavy work inline — delegate to agents
- Don't read long text aloud — summarize
- Don't use markdown or formatting in spoken replies`

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
 * Check if a process is alive.
 */
function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      return true
    }
    return false
  }
}

/**
 * Create FIFO using mkfifo command.
 */
function createFifo(path: string): boolean {
  try {
    const result = spawnSync('mkfifo', [path])
    return result.status === 0
  } catch {
    return false
  }
}

/**
 * Generate per-run MCP config by copying all servers from project's .mcp.json.
 * Ensures the call session has access to all tools (voice, memory, traces, etc).
 */
function generateMcpConfig(runDir: string, projectRoot: string): string {
  const configPath = join(runDir, 'mcp.json')
  const projectMcpPath = join(projectRoot, '.mcp.json')

  let mcpConfig: { mcpServers: Record<string, unknown> } = {
    mcpServers: {
      voice: {
        command: 'claude-call',
        args: ['serve'],
      },
    },
  }

  // Copy all MCP servers from project config if it exists, preserving voice
  if (existsSync(projectMcpPath)) {
    try {
      const projectConfig = JSON.parse(readFileSync(projectMcpPath, 'utf-8')) as { mcpServers?: Record<string, unknown> }
      if (projectConfig.mcpServers) {
        // Merge project servers with voice (voice takes precedence)
        mcpConfig.mcpServers = { ...projectConfig.mcpServers, voice: mcpConfig.mcpServers.voice }
      }
    } catch {
      // Fall back to just voice if project config is invalid
    }
  }

  writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2))
  return configPath
}

/**
 * Format uptime from startedAt timestamp.
 */
function formatUptime(startedAt: string): string {
  const start = new Date(startedAt).getTime()
  const now = Date.now()
  const seconds = Math.floor((now - start) / 1000)

  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  return `${hours}h ${mins}m`
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
 * In legacy mode, use pause file toggle instead of spawning a separate session.
 */
function writeCommandFiles(projectRoot: string, legacyMode: boolean): void {
  const commandsDir = join(projectRoot, '.claude', 'commands')
  mkdirSync(commandsDir, { recursive: true })

  let callStart: string
  let callStop: string

  if (legacyMode) {
    // Legacy mode: toggle pause file (voice runs in main session)
    callStart = `Resume voice input in the current session.

\`\`\`bash
rm -f /tmp/claude-call-pause
\`\`\`

Respond using the speak tool: "Voice resumed."
`

    callStop = `Pause voice input in the current session.

\`\`\`bash
touch /tmp/claude-call-pause
\`\`\`

Respond with "Voice paused." (text only, do not use speak tool).
`
  } else {
    // Dual mode: spawn/kill separate call session
    callStart = `Start a voice call session.

\`\`\`bash
claude-call call start
\`\`\`

After the call starts, the voice session will greet you automatically.
`

    callStop = `Stop the voice call session.

\`\`\`bash
claude-call call stop
\`\`\`

Respond with "Voice call ended." (text only).
`
  }

  const startPath = join(commandsDir, 'call-start.md')
  const stopPath = join(commandsDir, 'call-stop.md')

  writeFileSync(startPath, callStart)
  writeln(`  Created ${startPath}`)

  writeFileSync(stopPath, callStop)
  writeln(`  Created ${stopPath}`)
}

// ─── Call commands ──────────────────────────────────────────

/**
 * Start a call session.
 */
async function callStart(): Promise<void> {
  // 1. Determine project root
  const projectRoot = findProjectRoot() ?? process.cwd()

  // 2. Get run dir and ensure it exists
  const runDir = getRunDir(projectRoot)
  ensureRunDir(runDir)

  // 3. Acquire lock early with launcher PID (prevents race conditions)
  const lockHolder = getLockHolder(runDir)
  if (lockHolder !== null) {
    writeln(`Call session already running (PID ${lockHolder})`)
    process.exit(1)
  }
  if (!acquireLock(runDir, process.pid)) {
    writeln('Failed to acquire lock')
    process.exit(1)
  }

  let claudePid: number | null = null
  let fifoWriterPid: number | null = null

  // 4. Initialize workspace (creates .claude/call/ directory)
  initWorkspace(projectRoot)

  try {
    // 5. Create FIFO
    const fifoPath = getFifoPath(runDir)
    if (existsSync(fifoPath)) {
      spawnSync('rm', ['-f', fifoPath])
    }
    if (!createFifo(fifoPath)) {
      throw new Error(`Failed to create FIFO at ${fifoPath}`)
    }

    // 6. Generate per-run MCP config (copies all servers from project config)
    const mcpConfigPath = generateMcpConfig(runDir, projectRoot)

    // 7. Start persistent FIFO writer to keep FIFO open
    // Use exec so the PID is the real sleep process, not sh
    const fifoWriter = spawn('sh', ['-c', `exec sleep 999999 > "${fifoPath}"`], {
      detached: true,
      stdio: 'ignore',
    })
    fifoWriter.unref()
    fifoWriterPid = fifoWriter.pid!

    // 8. Spawn headless claude with FIFO as stdin via shell redirection
    // Use exec so the PID is the real claude process, not sh
    const stdoutLogPath = join(runDir, 'stdout.log')

    const claudeProc = spawn('sh', ['-c',
      `exec claude -p --input-format stream-json --output-format stream-json --verbose ` +
      `--mcp-config "${mcpConfigPath}" --dangerously-skip-permissions ` +
      `< "${fifoPath}" >> "${stdoutLogPath}" 2>&1`
    ], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        CLAUDE_CALL_RUN_DIR: runDir,
      },
    })
    claudeProc.unref()
    claudePid = claudeProc.pid!

    const sessionId = randomUUID()

    // 9. Update lock to claude PID (so lock stays valid after launcher exits)
    releaseLock(runDir, process.pid)
    if (!acquireLock(runDir, claudePid)) {
      throw new Error('Failed to acquire lock with claude PID')
    }

    // 10. Write status.json
    const status: StatusFile = {
      status: 'running',
      callPid: fifoWriterPid,
      claudePid,
      startedAt: new Date().toISOString(),
      projectRoot,
      sessionId,
    }
    writeStatus(runDir, status)

    // 11. Send bootstrap message through FIFO with timeout
    const bootstrapMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${CALL_SESSION_PROMPT}\n\n---\n\nYou are now in voice call mode. Always respond using the speak tool. Say hello to confirm you are ready.`,
          },
        ],
      },
    }

    // Use spawnSync with timeout to avoid blocking forever if claude fails to start
    const escapedMessage = JSON.stringify(bootstrapMessage).replace(/'/g, "'\\''")
    const result = spawnSync('sh', ['-c', `echo '${escapedMessage}' > "${fifoPath}"`], {
      timeout: 10000,
    })
    if (result.status !== 0) {
      throw new Error('Failed to send bootstrap message (timeout or FIFO error)')
    }

    // 12. Print success
    writeln(`Call session started (PID ${claudePid})`)
  } catch (err) {
    // Clean up on failure - kill any spawned processes
    if (claudePid && isProcessAlive(claudePid)) {
      try { process.kill(claudePid, 'SIGKILL') } catch { /* ignore */ }
    }
    if (fifoWriterPid && isProcessAlive(fifoWriterPid)) {
      try { process.kill(fifoWriterPid, 'SIGKILL') } catch { /* ignore */ }
    }
    // Release lock (try both PIDs in case we're in a transitional state)
    releaseLock(runDir, process.pid)
    if (claudePid) releaseLock(runDir, claudePid)
    cleanupRunDir(runDir)
    throw err
  }
}

/**
 * Wait for a process to exit, with timeout and force kill.
 */
function waitForProcessExit(pid: number, timeoutMs: number): void {
  if (!isProcessAlive(pid)) return

  // Send SIGTERM
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return // Process already gone
  }

  // Wait for exit with polling
  const pollInterval = 100
  const maxAttempts = Math.ceil(timeoutMs / pollInterval)
  for (let i = 0; i < maxAttempts; i++) {
    if (!isProcessAlive(pid)) return
    spawnSync('sleep', ['0.1'])
  }

  // Force kill if still alive
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Ignore
    }
  }
}

/**
 * Stop a call session.
 */
async function callStop(): Promise<void> {
  const projectRoot = findProjectRoot() ?? process.cwd()
  const runDir = getRunDir(projectRoot)

  // 1. Read status
  const status = readStatus(runDir)
  if (!status) {
    writeln('No call session running')
    return
  }

  // 2. Kill claude process and FIFO writer, waiting for exit
  waitForProcessExit(status.claudePid, 5000)
  waitForProcessExit(status.callPid, 2000)

  // 3. Release lock (using the PID that holds it)
  const lockHolder = getLockHolder(runDir)
  if (lockHolder !== null) {
    releaseLock(runDir, lockHolder)
  }

  // 4. Clean up run dir
  cleanupRunDir(runDir)

  // 5. Print status
  writeln('Call session stopped')
}

/**
 * Show call session status.
 */
async function callStatus(): Promise<void> {
  const projectRoot = findProjectRoot() ?? process.cwd()
  const runDir = getRunDir(projectRoot)

  // 1. Read status
  const status = readStatus(runDir)
  if (!status) {
    writeln('Status: stopped')
    writeln('No active call session')
    return
  }

  // 2. Check if processes are alive
  const claudeAlive = isProcessAlive(status.claudePid)
  const writerAlive = isProcessAlive(status.callPid)

  // 3. Determine actual status
  let actualStatus: string
  if (claudeAlive && writerAlive) {
    actualStatus = 'running'
  } else if (!claudeAlive && !writerAlive) {
    actualStatus = 'crashed'
  } else {
    actualStatus = 'crashed (partial)'
  }

  // 4. Print status
  writeln(`Status: ${actualStatus}`)
  writeln(`Claude PID: ${status.claudePid}${claudeAlive ? '' : ' (dead)'}`)
  writeln(`Writer PID: ${status.callPid}${writerAlive ? '' : ' (dead)'}`)
  writeln(`Uptime: ${formatUptime(status.startedAt)}`)
  writeln(`Project: ${status.projectRoot}`)
  writeln(`Session: ${status.sessionId}`)
}

// ─── Setup command ──────────────────────────────────────────

async function setup(legacyMode: boolean): Promise<void> {
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
    if (legacyMode) {
      // Legacy mode: add voice directly to project's .mcp.json (single-session mode)
      writeProjectMcpJson(projectRoot)
    }
    writeCommandFiles(projectRoot, legacyMode)
    effectiveProjectRoot = projectRoot
  } else {
    writeln('  No project root detected (no .git or package.json found).')
    if (await confirm('  Add to current directory?', false)) {
      const cwd = process.cwd()
      if (legacyMode) {
        // Legacy mode: add voice directly to .mcp.json (single-session mode)
        writeProjectMcpJson(cwd)
      }
      writeCommandFiles(cwd, legacyMode)
      effectiveProjectRoot = cwd
    } else {
      writeln('  Skipping project integration.')
    }
  }

  if (!legacyMode && effectiveProjectRoot) {
    writeln('  Voice server will load only in call sessions (dual-mode)')
    writeln('  Use /call-start to begin a voice call')
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
  if (legacyMode) {
    writeln('  Launch Claude Code with voice:')
    writeln()
    writeln('    \x1b[1mclaude --dangerously-load-development-channels server:voice\x1b[0m')
    writeln()
    writeln('  Then say \x1b[1m/call-start\x1b[0m to begin talking.')
  } else {
    writeln('  Start a voice call from Claude Code:')
    writeln()
    writeln('    \x1b[1m/call-start\x1b[0m')
    writeln()
    writeln('  This spawns a separate voice session. Stop it with \x1b[1m/call-stop\x1b[0m.')
    writeln()
    writeln('  Your main terminal stays free for typing.')
  }
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
const subcommand = process.argv[3]

// Check for --legacy flag in setup command
const hasLegacyFlag = process.argv.includes('--legacy')

switch (command) {
  case 'setup':
    setup(hasLegacyFlag).catch((err) => {
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

  case 'call':
    switch (subcommand) {
      case 'start':
        callStart().catch((err) => {
          writeln(`\nCall start failed: ${(err as Error).message}`)
          process.exit(1)
        })
        break
      case 'stop':
        callStop().catch((err) => {
          writeln(`\nCall stop failed: ${(err as Error).message}`)
          process.exit(1)
        })
        break
      case 'status':
        callStatus().catch((err) => {
          writeln(`\nCall status failed: ${(err as Error).message}`)
          process.exit(1)
        })
        break
      default:
        writeln()
        writeln('\x1b[1mclaude-call call\x1b[0m — Manage call sessions')
        writeln()
        writeln('Subcommands:')
        writeln('  start   Start a voice call session')
        writeln('  stop    Stop the current call session')
        writeln('  status  Show call session status')
        writeln()
        break
    }
    break

  default:
    writeln()
    writeln(`\x1b[1mclaude-call\x1b[0m v${VERSION}`)
    writeln('Continuous two-way voice conversations for Claude Code')
    writeln()
    writeln('Commands:')
    writeln('  setup           Interactive first-run setup')
    writeln('  setup --legacy  Setup for single-session mode (adds voice to .mcp.json)')
    writeln('  check           Verify dependencies and models')
    writeln('  serve           Start MCP channel server (used by Claude Code)')
    writeln('  call start      Start a voice call session')
    writeln('  call stop       Stop the current call session')
    writeln('  call status     Show call session status')
    writeln()
    writeln('Quick start:')
    writeln('  npx claude-call setup')
    writeln('  # Then from Claude Code: /call-start')
    writeln()
    break
}

#!/usr/bin/env node
/**
 * CLI entry point for claude-call.
 *
 * Commands:
 *   setup  — Interactive first-run setup (deps, models, config)
 *   check  — Verify everything works
 *   serve  — Start the MCP channel server (used by Claude Code, not humans)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, chmodSync, realpathSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
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
  setPauseSignalIn,
  clearPauseSignalIn,
  hasPauseSignalIn,
} from './runtime.js'
import { initWorkspace } from './workspace.js'

const VERSION = '0.1.0'

// ─── Call Session Prompt ─────────────────────────────────────

function buildCallSessionPrompt(projectRoot: string, runDir: string): string {
  const eventsFile = join(projectRoot, '.claude-call', 'events.jsonl')
  const sessionLog = join(runDir, 'stdout.log')
  return `# Call Session

You are **exo**, in voice call mode. User sees their terminal (the "shared screen") while talking.

**Project root:** ${projectRoot}
**Events file:** ${eventsFile}
**Session log:** ${sessionLog}

## Your Output Channels (CRITICAL)

You are running headless. Your text responses go to a log file — THE USER CANNOT SEE THEM.

You have exactly TWO ways to reach the user:
1. speak() — the user hears it
2. Event pointers — write a pointer to the events file so the main session can display your output

If you don't speak() it or write an event pointer, it didn't happen. Never output text expecting the user to read it.

## CRITICAL: Ack → Agent → Speak Pattern

You MUST follow this pattern for ANY request requiring tool use:
1. **Ack immediately** (1 sentence): "Got it", "One sec", "Checking"
2. **Dispatch Agent** with \`run_in_background: true\` — NEVER do the work inline
3. **When agent returns**, speak the result in 2-3 sentences max

Examples:
- User: "What's in the auth module?" → Speak: "One sec, checking." → Agent explores → Speak: "Found three files. Main entry is auth.ts with login and token refresh."
- User: "Find recent changes to the API" → Speak: "On it." → Agent searches git → Speak: "Two commits this week. Added rate limiting and fixed the timeout bug."
- User: "How does the cache work?" → Speak: "Let me look." → Agent reads code → Speak: "It's an LRU cache with a five minute TTL. I put the details on screen."

NEVER answer inline if it requires reading files, searching, or multi-step work. Even simple lookups go to agents.

## Voice Brevity Rule

Spoken responses: keep them concise. If you have detailed output:
1. Write an event pointer (see below)
2. Speak a summary: "Done, it's on screen" or "Check the terminal"

## Writing Event Pointers (IMPORTANT)

When a background agent completes and returns results, when user says "show me" or "put it on screen", or when you have significant output that should be visible to the user:

After writing your detailed text response, run a Bash command to append an event pointer:

\`\`\`bash
UUID=$(grep '"type":"assistant"' '${sessionLog}' | tail -1 | jq -r '.uuid')
echo '{"ts":"'$(date -u +%FT%TZ)'","uuid":"'"$UUID"'","log":"${sessionLog}","title":"TITLE_HERE"}' >> '${eventsFile}'
\`\`\`

Replace TITLE_HERE with a short descriptive title (e.g., "Auth Module Overview", "Git Changes This Week").

The main session's watcher will pick up the event, fetch your full message from the session log, and display it.

## Voice Style

Concise, conversational, no markdown. "Got it, running sync" not "I will now execute the sync command."

## Voice Commands

- "exo pause" — say "paused", then sleep
- "exo start" — resume
- "exo" during speech — stop talking

## Don'ts

- Never go silent without acking
- Never do heavy work inline — always delegate
- Never just say you'll write an event pointer — actually run the Bash command`
}

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
 * Install skill files to ~/.claude/commands/ and scripts to the app scripts dir.
 * Called at the end of setup to make /call-start, /call-stop, etc. available globally.
 */
function installSkillsAndScripts(): void {
  // Determine the app root directory.
  // When running from the installed location (~/.claude-call/app/dist/cli.js),
  // the app root is one level up from the dist/ directory.
  // Use realpathSync to resolve symlinks (e.g., /usr/local/bin/claude-call → ~/.claude-call/app/dist/cli.js)
  const appRoot = resolve(dirname(realpathSync(process.argv[1])), '..')

  // 1. Install skill files to ~/.claude/commands/
  const skillsSrc = join(appRoot, 'skills')
  const commandsDest = join(homedir(), '.claude', 'commands')

  if (existsSync(skillsSrc)) {
    mkdirSync(commandsDest, { recursive: true })
    const skillFiles = readdirSync(skillsSrc).filter(f => f.endsWith('.md'))
    for (const file of skillFiles) {
      copyFileSync(join(skillsSrc, file), join(commandsDest, file))
      writeln(`  Installed ${file} → ${join(commandsDest, file)}`)
    }
  } else {
    writeln(`  \x1b[33mSkills directory not found at ${skillsSrc} — skipping skill install\x1b[0m`)
  }

  // 2. Install scripts to ~/.claude-call/app/scripts/
  const scriptsSrc = join(appRoot, 'scripts')
  const scriptsDest = join(homedir(), '.claude-call', 'app', 'scripts')

  if (existsSync(scriptsSrc)) {
    mkdirSync(scriptsDest, { recursive: true })
    const scriptFiles = readdirSync(scriptsSrc).filter(f => f.endsWith('.sh'))
    for (const file of scriptFiles) {
      const destPath = join(scriptsDest, file)
      copyFileSync(join(scriptsSrc, file), destPath)
      chmodSync(destPath, 0o755)
      writeln(`  Installed ${file} → ${destPath}`)
    }
  } else {
    writeln(`  \x1b[33mScripts directory not found at ${scriptsSrc} — skipping script install\x1b[0m`)
  }
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

  // 4. Initialize workspace (creates .claude-call/ directory)
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
            text: `${buildCallSessionPrompt(projectRoot, runDir)}\n\n---\n\nYou are now in voice call mode. Always respond using the speak tool. Say hello to confirm you are ready.`,
          },
        ],
      },
    }

    // Use spawnSync with stdin pipe to avoid shell escaping issues with long prompts
    const bootstrapJson = JSON.stringify(bootstrapMessage) + '\n'
    const result = spawnSync('sh', ['-c', `cat > "${fifoPath}"`], {
      input: bootstrapJson,
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
 * Pause a call session (mic stays alive, stops processing).
 */
async function callPause(): Promise<void> {
  const projectRoot = findProjectRoot() ?? process.cwd()
  const runDir = getRunDir(projectRoot)

  const status = readStatus(runDir)
  if (!status) {
    writeln('No call session running')
    return
  }

  if (hasPauseSignalIn(runDir)) {
    writeln('Call session already paused')
    return
  }

  setPauseSignalIn(runDir)
  writeln('Call session paused')
}

/**
 * Resume a paused call session.
 */
async function callResume(): Promise<void> {
  const projectRoot = findProjectRoot() ?? process.cwd()
  const runDir = getRunDir(projectRoot)

  const status = readStatus(runDir)
  if (!status) {
    writeln('No call session running')
    return
  }

  if (!hasPauseSignalIn(runDir)) {
    writeln('Call session is not paused')
    return
  }

  clearPauseSignalIn(runDir)
  writeln('Call session resumed')
}

/**
 * Enable wake word prefix — user must say "exo" before each command.
 */
async function callPrefixOn(): Promise<void> {
  const projectRoot = findProjectRoot() ?? process.cwd()
  const runDir = getRunDir(projectRoot)

  const status = readStatus(runDir)
  if (!status) {
    writeln('No call session running')
    return
  }

  writeFileSync(join(runDir, 'prefix'), `prefix enabled at ${new Date().toISOString()}`)
  // Remove no-prefix override if it exists
  const noPrefixPath = join(runDir, 'no-prefix')
  if (existsSync(noPrefixPath)) rmSync(noPrefixPath)
  writeln('Wake word prefix enabled — say "exo" before each command')
}

/**
 * Disable wake word prefix — all speech is processed directly.
 */
async function callPrefixOff(): Promise<void> {
  const projectRoot = findProjectRoot() ?? process.cwd()
  const runDir = getRunDir(projectRoot)

  const status = readStatus(runDir)
  if (!status) {
    writeln('No call session running')
    return
  }

  // Create no-prefix file to override config.wakeWord.enabled
  writeFileSync(join(runDir, 'no-prefix'), `disabled at ${new Date().toISOString()}`)
  // Also remove the prefix file if it exists
  const prefixPath = join(runDir, 'prefix')
  if (existsSync(prefixPath)) rmSync(prefixPath)
  writeln('Wake word prefix disabled — all speech processed directly')
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

  // Step 3: Install skills and scripts globally
  writeln('\x1b[1m3. Installing skills and scripts...\x1b[0m')
  writeln()
  installSkillsAndScripts()
  writeln()

  // Look for pronunciation.yaml in the project directory
  let pronunciationFile: string | undefined
  const projectRoot = findProjectRoot()
  if (projectRoot) {
    const pronunciationPaths = [
      join(projectRoot, 'data', 'integrations', 'voice', 'pronunciation.yaml'),
      join(projectRoot, 'pronunciation.yaml'),
      join(projectRoot, 'config', 'pronunciation.yaml'),
    ]
    for (const p of pronunciationPaths) {
      if (existsSync(p)) {
        pronunciationFile = resolve(p)
        writeln(`  Found pronunciation dictionary: ${pronunciationFile}`)
        break
      }
    }
  }

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
  writeln('  Start a voice call from any Claude Code session:')
  writeln()
  writeln('    \x1b[1m/call-start\x1b[0m')
  writeln()
  writeln('  This spawns a separate voice session. Stop it with \x1b[1m/call-stop\x1b[0m.')
  writeln()
  writeln('  Your main terminal stays free for typing.')
  writeln()
  writeln('  Skills installed globally to ~/.claude/commands/ — available in all projects.')
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
      case 'pause':
        callPause().catch((err) => {
          writeln(`\nCall pause failed: ${(err as Error).message}`)
          process.exit(1)
        })
        break
      case 'resume':
        callResume().catch((err) => {
          writeln(`\nCall resume failed: ${(err as Error).message}`)
          process.exit(1)
        })
        break
      case 'prefix-on':
        callPrefixOn().catch((err) => {
          writeln(`\nPrefix enable failed: ${(err as Error).message}`)
          process.exit(1)
        })
        break
      case 'prefix-off':
        callPrefixOff().catch((err) => {
          writeln(`\nPrefix disable failed: ${(err as Error).message}`)
          process.exit(1)
        })
        break
      default:
        writeln()
        writeln('\x1b[1mclaude-call call\x1b[0m — Manage call sessions')
        writeln()
        writeln('Subcommands:')
        writeln('  start       Start a voice call session')
        writeln('  stop        Stop the current call session')
        writeln('  pause       Pause the call session')
        writeln('  resume      Resume a paused call session')
        writeln('  prefix-on   Enable "exo" wake word prefix')
        writeln('  prefix-off  Disable wake word prefix')
        writeln('  status      Show call session status')
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
    writeln('  check           Verify dependencies and models')
    writeln('  serve           Start MCP channel server (used by Claude Code)')
    writeln('  call start      Start a voice call session')
    writeln('  call stop       Stop the current call session')
    writeln('  call pause      Pause the call session')
    writeln('  call resume     Resume a paused call session')
    writeln('  call status     Show call session status')
    writeln()
    writeln('Quick start:')
    writeln('  npx claude-call setup')
    writeln('  # Then from Claude Code: /call-start')
    writeln()
    break
}

#!/usr/bin/env node
/**
 * CLI entry point for claude-call.
 *
 * Commands:
 *   install — Global setup (deps, models, config)
 *   init    — Per-project setup (.mcp.json)
 *   check  — Verify everything works
 *   serve  — Start the MCP channel server (used by Claude Code, not humans)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, readdirSync, realpathSync, rmSync } from 'node:fs'
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
  writeStatus,
  readStatus,
  updateStatus,
  cleanupRunDir,
  ensureRunDir,
  type StatusFile,
  type VoiceLock,
  setMuteSignalIn,
  clearMuteSignalIn,
  hasMuteSignalIn,
  acquireVoiceLock,
  releaseVoiceLock,
  updateVoiceLockPid,
  resolveActiveRunDir,
  resolveActiveSession,
} from './runtime.js'
import { initWorkspace } from './workspace.js'

const VERSION = '0.1.0'

// ─── Call Session Prompt ─────────────────────────────────────

function buildCallSessionPrompt(projectRoot: string): string {
  return `# Call Session

You are **exo**, in voice call mode. User sees their terminal (the "shared screen") while talking.

**Project root:** ${projectRoot}

## Your Output Channels (CRITICAL)

You are running headless. Your text responses go to a log file — THE USER CANNOT SEE THEM.

You have exactly ONE way to reach the user: **speak()**. If you don't speak it, the user didn't hear it.

Background agents return results to YOU — you then decide when and how to speak them to the user (see Agent Results below).

Never output text expecting the user to read it.

## CRITICAL: Ack → Agent → Speak Pattern

You MUST follow this pattern for ANY request requiring real work:
1. **Ack by echoing intent** (1 sentence): Say WHAT you're about to do, not just "got it"
2. **Dispatch Agent** with \`run_in_background: true\` — do the work in background
3. **When agent returns**, surface the result based on context (see Agent Results below)

Examples:
- User: "What's in the auth module?" → Speak: "Checking the auth module." → Agent explores → Speak: "Found three files. Main entry is auth.ts with login and token refresh."
- User: "Run sync and then let's do morning" → Speak: "Running sync, then we'll plan the morning." → Agent runs sync → Speak result
- User: "How does the cache work?" → Speak: "Looking at the cache code." → Agent reads code → Speak: "It's an LRU cache with a five minute TTL."
- User: "Track that I need to call the dentist" → Speak: "Tracking the dentist call." → Agent creates trace → Speak: "Done, added it."

Always echo back the specific action so the user knows you understood correctly. NEVER use generic acks like "got it" or "one sec" alone.

## Tool Usage Rule

Keep the voice loop responsive. Only these tools are allowed directly:
- **speak** — how you talk to the user
- **Agent** (with \`run_in_background: true\`) — how you do work
- **Read** — one quick file read per request (e.g., checking a config value)
- **Bash** — only for monitor event curls (see below)

Everything else (Write, Edit, Grep, Glob, WebSearch, etc.) MUST go through a background agent. If a request needs more than a spoken response and a single file read, dispatch an agent.

## Voice Brevity Rule

Spoken responses: keep them concise. Summarize, don't recite.

## Monitor Events

Before dispatching an agent, POST a dispatch event via Bash so the monitor shows it:
curl -s -X POST http://localhost:9847/display -H 'Content-Type: application/json' -d "{\\"agent\\": {\\"event\\": \\"dispatch\\", \\"name\\": \\"AGENT_NAME\\", \\"id\\": \\"AGENT_NAME-$(date -u +%Y-%m-%dT%H:%M:%SZ)\\", \\"ts\\": \\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\"}}"

Include in agent instructions — when done, POST a completion event with the SAME \`id\`:
curl -s -X POST http://localhost:9847/display -H 'Content-Type: application/json' -d "{\\"agent\\": {\\"event\\": \\"complete\\", \\"name\\": \\"AGENT_NAME\\", \\"id\\": \\"DISPATCH_ID\\", \\"ts\\": \\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\"}}"

The \`id\` must match between dispatch and complete for the monitor to track correctly. Pass the exact dispatch ID string to the agent prompt so it can use it in the completion event.

## Agent Results

When a background agent completes, you receive its result automatically.
Do NOT immediately speak the full result. Instead:
- If the user is mid-conversation on another topic: brief interjection — "btw, the sync finished" or "item 3 is done"
- Let the user decide when to expand: they'll say "tell me about it" or "later"
- Only give the full result when the user asks for it or when there's a natural pause
- Never interrupt the current conversation flow with agent reports

## Voice Style

Concise, conversational, no markdown. "Got it, running sync" not "I will now execute the sync command."

## Voice Commands

- "exo mute" — mute voice input. You keep working, agents keep running. Say "muted" before going silent.
- "exo unmute" / "exo start" — resume voice. Summarize what happened while muted in 1-2 sentences.
- "exo" / "stop" during speech — stop talking immediately

## On Unmute

When the user unmutes (you receive "[Voice unmuted]"), briefly summarize:
- What agents completed while muted
- Any notable results
- Keep it to 1-2 sentences. User can ask for details.
Example: "While you were muted, the sync finished and found 3 overdue items. Want the details?"

## Don'ts

- Never go silent without acking
- Never use Write, Edit, Grep, or Glob directly — always delegate to agents (Bash is allowed only for monitor event curls)
- Never do multi-step work inline — dispatch an agent`
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
 * Install skill files to ~/.claude/commands/ and the display server to the app dir.
 * Install skill files to ~/.claude/commands/ and launcher scripts to ~/.claude-call/bin/.
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

  // 2. Copy compiled dist/ to ~/.claude-call/app/dist/ (includes cli, display-server, tui, etc.)
  const distSrc = resolve(join(appRoot, 'dist'))
  const distDest = resolve(join(homedir(), '.claude-call', 'app', 'dist'))

  if (distSrc === distDest) {
    writeln(`  dist/ already in place (running from installed location)`)
  } else if (existsSync(distSrc)) {
    cpSync(distSrc, distDest, { recursive: true, force: true })
    writeln(`  Installed dist/ → ${distDest}`)
  } else {
    writeln(`  \x1b[33mdist/ not found at ${distSrc} — skipping\x1b[0m`)
  }

  // 2b. Copy node_modules/ to ~/.claude-call/app/node_modules/ (runtime dependencies)
  const nodeModulesSrc = resolve(join(appRoot, 'node_modules'))
  const nodeModulesDest = resolve(join(homedir(), '.claude-call', 'app', 'node_modules'))

  if (nodeModulesSrc === nodeModulesDest) {
    writeln(`  node_modules/ already in place (running from installed location)`)
  } else if (existsSync(nodeModulesSrc)) {
    cpSync(nodeModulesSrc, nodeModulesDest, { recursive: true, force: true })
    writeln(`  Installed node_modules/ → ${nodeModulesDest}`)
  } else {
    writeln(`  \x1b[33mnode_modules/ not found at ${nodeModulesSrc} — skipping\x1b[0m`)
  }

  // 3. Install launcher scripts (eld, eldc, eldr) to ~/.claude-call/bin/
  const binSrc = resolve(join(appRoot, 'bin'))
  const binDest = resolve(join(homedir(), '.claude-call', 'bin'))
  mkdirSync(binDest, { recursive: true })

  if (existsSync(binSrc)) {
    const launchers = readdirSync(binSrc).filter(f => !f.startsWith('.'))
    for (const file of launchers) {
      copyFileSync(join(binSrc, file), join(binDest, file))
      try { execSync(`chmod +x "${join(binDest, file)}"`) } catch { /* ignore */ }
      writeln(`  Installed ${file} → ${join(binDest, file)}`)
    }
  }
}

/**
 * Add call-display MCP entry to the project's .mcp.json.
 */
/**
 * Register call-display MCP server in global ~/.claude/settings.json.
 * This makes the display channel available in every Claude session without per-project init.
 */
function addDisplayMcpGlobal(): void {
  const claudeJsonPath = join(homedir(), '.claude.json')
  let config: Record<string, unknown> = {}

  if (existsSync(claudeJsonPath)) {
    try {
      config = JSON.parse(readFileSync(claudeJsonPath, 'utf-8')) as Record<string, unknown>
    } catch {
      writeln('  \x1b[33mWarning: ~/.claude.json is malformed, skipping MCP registration\x1b[0m')
      writeln('  Add manually: "mcpServers": { "call-display": { "command": "node", "args": ["/path/to/display-server.js"] } }')
      return
    }
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {}
  }

  const displayServerPath = join(homedir(), '.claude-call', 'app', 'dist', 'display-server.js')
  ;(config.mcpServers as Record<string, unknown>)['call-display'] = {
    command: 'node',
    args: [displayServerPath],
  }

  writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + '\n')
  writeln(`  Registered call-display in ${claudeJsonPath}`)
}

/**
 * Remove call-display MCP server from global ~/.claude.json.
 */
function removeDisplayMcpGlobal(): void {
  const claudeJsonPath = join(homedir(), '.claude.json')
  if (!existsSync(claudeJsonPath)) return

  try {
    const config = JSON.parse(readFileSync(claudeJsonPath, 'utf-8')) as Record<string, unknown>
    const servers = config.mcpServers as Record<string, unknown> | undefined
    if (servers && 'call-display' in servers) {
      delete servers['call-display']
      if (Object.keys(servers).length === 0) {
        delete config.mcpServers
      }
      writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + '\n')
    }
  } catch {
    // Best-effort
  }
}

// ─── Call commands ──────────────────────────────────────────

/**
 * Start a call session.
 */
async function callStart(): Promise<void> {
  // 1. Determine project root
  const projectRoot = findProjectRoot() ?? process.cwd()
  const sessionId = randomUUID()

  // 2. Get run dir and ensure it exists
  const runDir = getRunDir(projectRoot)
  ensureRunDir(runDir)

  // 3. Acquire global voice lock (only one voice session allowed — mic is shared)
  const voiceLock: VoiceLock = {
    runDir,
    projectRoot,
    pid: process.pid,
    sessionId,
    startedAt: new Date().toISOString(),
  }

  const existingSession = resolveActiveSession()
  if (existingSession !== null) {
    writeln(`Call session already running (PID ${existingSession.pid}, project: ${existingSession.projectRoot})`)
    writeln('Only one voice session can be active at a time (shared mic).')
    writeln('Stop it first: claude-call call stop')
    process.exit(1)
  }

  if (!acquireVoiceLock(voiceLock)) {
    writeln('Failed to acquire voice lock')
    process.exit(1)
  }

  let claudePid: number | null = null
  let fifoWriterPid: number | null = null

  // 5. Initialize workspace (creates .claude-call/ directory)
  initWorkspace(projectRoot)

  try {
    // 6. Create FIFO
    const fifoPath = getFifoPath(runDir)
    if (existsSync(fifoPath)) {
      spawnSync('rm', ['-f', fifoPath])
    }
    if (!createFifo(fifoPath)) {
      throw new Error(`Failed to create FIFO at ${fifoPath}`)
    }

    // 7. Generate per-run MCP config (copies all servers from project config)
    const mcpConfigPath = generateMcpConfig(runDir, projectRoot)

    // 8. Start persistent FIFO writer to keep FIFO open
    // Use exec so the PID is the real sleep process, not sh
    const fifoWriter = spawn('sh', ['-c', `exec sleep 999999 > "${fifoPath}"`], {
      detached: true,
      stdio: 'ignore',
    })
    fifoWriter.unref()
    fifoWriterPid = fifoWriter.pid!

    // 9. Spawn headless claude with FIFO as stdin via shell redirection
    // Use exec so the PID is the real claude process, not sh
    const stdoutLogPath = join(runDir, 'stdout.log')

    const claudeProc = spawn('sh', ['-c',
      `exec claude -p --input-format stream-json --output-format stream-json --verbose ` +
      `--mcp-config "${mcpConfigPath}" --strict-mcp-config --dangerously-skip-permissions ` +
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

    // 10. Update voice lock PID to claude (so lock stays valid after launcher exits)
    if (!updateVoiceLockPid(process.pid, claudePid)) {
      throw new Error('Failed to update voice lock with claude PID')
    }

    // 11. Write status.json
    const status: StatusFile = {
      status: 'running',
      callPid: fifoWriterPid,
      claudePid,
      startedAt: voiceLock.startedAt,
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
            text: `${buildCallSessionPrompt(projectRoot)}\n\n---\n\nYou are now in voice call mode. Always respond using the speak tool. Say hello to confirm you are ready.`,
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
    // Release voice lock (try both PIDs in case we're in a transitional state)
    releaseVoiceLock(process.pid)
    if (claudePid) releaseVoiceLock(claudePid)
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
  // Support --if-pid <pid> flag: only stop if voice.lock PID matches.
  // Used by eld EXIT trap to avoid killing a newer session that took over.
  const ifPidIdx = process.argv.indexOf('--if-pid')
  const ifPid = ifPidIdx !== -1 ? parseInt(process.argv[ifPidIdx + 1], 10) : null

  // 1. Resolve active session from global voice lock
  const session = resolveActiveSession()
  if (!session) {
    writeln('No call session running')
    return
  }

  // 2. If --if-pid was given, only stop if PID matches
  if (ifPid !== null && session.pid !== ifPid) {
    // A different session took over — don't kill it
    return
  }

  const runDir = session.runDir

  // 3. Read status for process PIDs
  const status = readStatus(runDir)
  if (status) {
    // 4. Kill claude process and FIFO writer, waiting for exit
    waitForProcessExit(status.claudePid, 5000)
    waitForProcessExit(status.callPid, 2000)
  } else {
    // Status missing but lock exists - try killing the lock holder PID
    // (this covers race where stop is called before status.json is written)
    waitForProcessExit(session.pid, 5000)
  }

  // 5. Release voice lock
  releaseVoiceLock(session.pid)

  // 6. Clean up run dir
  cleanupRunDir(runDir)

  // 7. Print status
  writeln('Call session stopped')
}

/**
 * Mute a call session (mic stays alive, stops processing).
 */
async function callMute(): Promise<void> {
  const runDir = resolveActiveRunDir()
  if (!runDir) {
    writeln('No call session running')
    return
  }

  if (hasMuteSignalIn(runDir)) {
    writeln('Call session already muted')
    return
  }

  setMuteSignalIn(runDir)
  updateStatus(runDir, { status: 'muted' })
  writeln('Call session muted')
}

/**
 * Unmute a call session.
 */
async function callUnmute(): Promise<void> {
  const runDir = resolveActiveRunDir()
  if (!runDir) {
    writeln('No call session running')
    return
  }

  if (!hasMuteSignalIn(runDir)) {
    writeln('Call session is not muted')
    return
  }

  clearMuteSignalIn(runDir)
  updateStatus(runDir, { status: 'running' })
  writeln('Call session unmuted')
}

/**
 * Enable wake word prefix — user must say "exo" before each command.
 */
async function callPrefixOn(): Promise<void> {
  const runDir = resolveActiveRunDir()
  if (!runDir) {
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
  const runDir = resolveActiveRunDir()
  if (!runDir) {
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
  // 1. Check global voice lock for active session
  const session = resolveActiveSession()
  if (!session) {
    writeln('Status: stopped')
    writeln('No active call session')
    return
  }

  const runDir = session.runDir

  // 2. Read status file for process details
  const status = readStatus(runDir)
  if (!status) {
    // Voice lock exists but status file missing - unusual state
    writeln('Status: unknown')
    writeln(`Session PID: ${session.pid}`)
    writeln(`Project: ${session.projectRoot}`)
    return
  }

  // 3. Check if processes are alive
  const claudeAlive = isProcessAlive(status.claudePid)
  const writerAlive = isProcessAlive(status.callPid)

  // 4. Determine actual status
  let actualStatus: string
  if (!claudeAlive || !writerAlive) {
    actualStatus = (!claudeAlive && !writerAlive) ? 'crashed' : 'crashed (partial)'
  } else {
    actualStatus = status.status
  }

  // 5. Print status
  writeln(`Status: ${actualStatus}`)
  writeln(`Claude PID: ${status.claudePid}${claudeAlive ? '' : ' (dead)'}`)
  writeln(`Writer PID: ${status.callPid}${writerAlive ? '' : ' (dead)'}`)
  writeln(`Uptime: ${formatUptime(status.startedAt)}`)
  writeln(`Project: ${status.projectRoot}`)
  writeln(`Session: ${status.sessionId}`)
}

// ─── Install command (global, once) ────────────────────────

async function install(): Promise<void> {
  writeln()
  writeln('\x1b[1mclaude-call install\x1b[0m  v' + VERSION)
  writeln('Global installation — run once, then use "claude-call init" per project.')
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
      writeln('Install manually and re-run install.')
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

  const whisperServerBinary = findBinaryInPath('whisper-server')
  const whisperModelFile = join(getModelsDir(), whisperSize === 'large' ? 'ggml-large-v3-turbo.bin' : 'ggml-base.bin')

  if (whisperServerBinary) {
    if (existsSync(whisperModelFile)) {
      try {
        const alreadyRunning = await checkWhisperHealth()
        if (alreadyRunning) {
          writeln('  whisper-server already running on 127.0.0.1:8178')
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

          const started = await waitForWhisperHealth(5000)
          if (started) {
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

  // Step 3: Install skills, scripts, and display server globally
  writeln('\x1b[1m3. Installing skills, launcher scripts, and display server...\x1b[0m')
  writeln()
  installSkillsAndScripts()
  writeln()

  // Step 4: Write global config
  writeln('\x1b[1m4. Writing configuration...\x1b[0m')
  writeln()

  const config = loadConfig()
  const configDir = config.dataDir
  mkdirSync(configDir, { recursive: true })

  // Wire up pronunciation if user has a custom file
  let pronunciationFile: string | undefined
  const userPronPath = join(configDir, 'pronunciation.yaml')
  if (existsSync(userPronPath)) {
    pronunciationFile = userPronPath
    writeln(`  Found pronunciation dictionary: ${pronunciationFile}`)
  }

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

  // Step 5: Register call-display MCP in global Claude settings
  writeln('\x1b[1m5. Registering display channel globally...\x1b[0m')
  writeln()
  addDisplayMcpGlobal()
  writeln()

  // Step 6: Done
  writeln('\x1b[1m6. Install complete!\x1b[0m')
  writeln()
  writeln('  Add ~/.claude-call/bin to your PATH:')
  writeln()
  writeln('    \x1b[2mexport PATH="$HOME/.claude-call/bin:$PATH"\x1b[0m')
  writeln()
  writeln('  Then run \x1b[1meld\x1b[0m from any project directory.')
  writeln()
}

// ─── Init command (per-project) ────────────────────────────

async function init(): Promise<void> {
  writeln()
  writeln('\x1b[1mclaude-call init\x1b[0m')
  writeln()

  // Check that install has been run
  const configPath = join(loadConfig().dataDir, 'config.yaml')
  if (!existsSync(configPath)) {
    writeln('\x1b[31mclaude-call is not installed.\x1b[0m')
    writeln('Run \x1b[1mclaude-call install\x1b[0m first.')
    process.exit(1)
  }

  const projectRoot = findProjectRoot()
  if (!projectRoot) {
    writeln('\x1b[31mNo project found.\x1b[0m Run this from a directory with .git or package.json.')
    process.exit(1)
  }

  writeln(`  Project: ${projectRoot}`)
  writeln()

  // Check for project pronunciation.yaml
  const pronunciationPaths = [
    join(projectRoot, 'data', 'integrations', 'voice', 'pronunciation.yaml'),
    join(projectRoot, 'pronunciation.yaml'),
    join(projectRoot, 'config', 'pronunciation.yaml'),
  ]
  for (const p of pronunciationPaths) {
    if (existsSync(p)) {
      writeln(`  Found pronunciation dictionary: ${resolve(p)}`)
      writeln(`  Set in config: pronunciation.file: ${resolve(p)}`)
      break
    }
  }

  // Done
  writeln('\x1b[1mInit complete!\x1b[0m')
  writeln()
  writeln('  Start a voice call with:')
  writeln()
  writeln('    \x1b[1meld\x1b[0m      — Claude + voice')
  writeln('    \x1b[1meldc\x1b[0m     — Claude + voice, continue last conversation')
  writeln('    \x1b[1meldr\x1b[0m     — Claude + voice, resume last conversation')
  writeln()
  writeln('  Or use \x1b[1m/call-start\x1b[0m from any Claude Code session.')
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
      keywords: ['stop', 'hold on', 'pause', 'exo'],
    },
  }

  if (pronunciationFile) {
    config.pronunciation = { file: pronunciationFile }
  }

  writeFileSync(configPath, stringifyYaml(config))
  writeln(`  Config written to ${configPath}`)
}

// ─── Uninstall command ─────────────────────────────────────

async function uninstall(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const dataDir = loadConfig().dataDir
  const commandsDir = join(homedir(), '.claude', 'commands')

  writeln()
  writeln(dryRun ? '\x1b[1mclaude-call uninstall --dry-run\x1b[0m' : '\x1b[1mclaude-call uninstall\x1b[0m')
  writeln()

  // Check for active call sessions
  const runsDir = join(dataDir, 'runs')
  if (existsSync(runsDir)) {
    const entries = readdirSync(runsDir)
    for (const entry of entries) {
      const runDir = join(runsDir, entry)
      const status = readStatus(runDir)
      if (status && isProcessAlive(status.claudePid)) {
        writeln(`\x1b[31mActive call session detected (PID ${status.claudePid}).\x1b[0m`)
        writeln('Run \x1b[1mclaude-call call stop\x1b[0m first.')
        process.exit(1)
      }
    }
  }

  // Build list of things to remove
  const items: { path: string; desc: string; exists: boolean }[] = []

  items.push({ path: dataDir, desc: 'Data directory (config, models, logs, runs, bin)', exists: existsSync(dataDir) })

  // Skill files
  if (existsSync(commandsDir)) {
    const knownSkills = ['call-start.md', 'call-stop.md', 'call-mute.md', 'call-unmute.md', 'call-status.md', 'call-prefix-on.md', 'call-prefix-off.md']
    const skills = readdirSync(commandsDir).filter(f => knownSkills.includes(f))
    for (const s of skills) {
      items.push({ path: join(commandsDir, s), desc: `Skill: ${s}`, exists: true })
    }
  }

  // CLI symlink
  const symlinkPath = '/usr/local/bin/claude-call'
  if (existsSync(symlinkPath)) {
    items.push({ path: symlinkPath, desc: 'CLI symlink (may need sudo to remove)', exists: true })
  }

  // Check for whisper-server on port 8178 (best-effort — may not be ours)
  let whisperRunning = false
  try {
    whisperRunning = await checkWhisperHealth()
  } catch { /* ignore */ }

  const existing = items.filter(i => i.exists)
  if (existing.length === 0 && !whisperRunning) {
    writeln('Nothing to uninstall.')
    return
  }

  writeln('Will remove:')
  for (const item of existing) {
    writeln(`  \x1b[31m-\x1b[0m ${item.path}`)
    writeln(`    ${item.desc}`)
  }
  if (whisperRunning) {
    writeln(`  \x1b[31m-\x1b[0m whisper-server process on port 8178`)
  }
  writeln()

  // Global MCP entry
  writeln(`  \x1b[31m-\x1b[0m ~/.claude.json mcpServers.call-display`)
  writeln(`    Global MCP server entry`)

  // Installed dependencies
  writeln()
  writeln('\x1b[33mManual step:\x1b[0m Remove installed dependencies if no longer needed:')
  writeln('  brew uninstall sox whisper-cpp')
  writeln('  pip uninstall piper-tts edge-tts')
  writeln('  # Qwen3-TTS daemon (if installed separately)')
  writeln('  # Silero VAD model + Piper/Whisper models are inside ~/.claude-call/')
  writeln()

  // PATH notice
  const pathLine = 'export PATH="$HOME/.claude-call/bin:$PATH"'
  writeln('\x1b[33mManual step:\x1b[0m Remove this line from your shell config (.zshrc / .bashrc):')
  writeln(`  ${pathLine}`)
  writeln()

  if (dryRun) {
    writeln('\x1b[2m(dry run — nothing was deleted)\x1b[0m')
    return
  }

  if (!await confirm('Proceed with uninstall?', false)) {
    writeln('Aborted.')
    return
  }

  // Kill whisper-server
  if (whisperRunning) {
    writeln('  Stopping whisper-server...')
    try {
      // Find and kill whisper-server listening on port 8178
      const result = spawnSync('lsof', ['-ti', ':8178'])
      if (result.status === 0) {
        const pids = result.stdout.toString().trim().split('\n')
        for (const pid of pids) {
          try { process.kill(parseInt(pid, 10), 'SIGTERM') } catch { /* ignore */ }
        }
        writeln('  whisper-server stopped')
      }
    } catch { /* ignore */ }
  }

  // Remove files
  for (const item of existing) {
    try {
      rmSync(item.path, { recursive: true, force: true })
      writeln(`  \x1b[32mRemoved\x1b[0m ${item.path}`)
    } catch {
      // May need sudo for /usr/local/bin symlink
      try {
        spawnSync('sudo', ['rm', '-rf', item.path], { stdio: 'inherit' })
        writeln(`  \x1b[32mRemoved\x1b[0m ${item.path}`)
      } catch (err2) {
        writeln(`  \x1b[31mFailed\x1b[0m ${item.path}: ${(err2 as Error).message}`)
      }
    }
  }

  // Remove call-display from global Claude settings
  removeDisplayMcpGlobal()
  writeln('  \x1b[32mRemoved\x1b[0m call-display from ~/.claude.json')

  writeln()
  writeln('Uninstall complete.')
  writeln()
  writeln(`Don't forget to remove the PATH line from your shell config.`)
  writeln()
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
    writeln('\x1b[31mSome requirements are missing. Run "claude-call install" to fix.\x1b[0m')
  }
  writeln()
}

// ─── Serve command ──────────────────────────────────────────

async function serve(): Promise<void> {
  // Dynamically import the channel to start the MCP server
  await import('./channel.js')
}

// ─── Monitor command ────────────────────────────────────────

async function monitor(): Promise<void> {
  // Dynamically import the TUI monitor (compiled separately to dist/tui/)
  // Use variable to prevent TypeScript from resolving tsx file at compile time
  const tuiPath = './tui/index.js'
  await import(tuiPath)
}

// ─── Main ───────────────────────────────────────────────────

const command = process.argv[2]
const subcommand = process.argv[3]

switch (command) {
  case 'install':
    install().catch((err) => {
      writeln(`\nInstall failed: ${(err as Error).message}`)
      process.exit(1)
    })
    break

  case 'init':
    init().catch((err) => {
      writeln(`\nInit failed: ${(err as Error).message}`)
      process.exit(1)
    })
    break

  case 'uninstall':
    uninstall().catch((err) => {
      writeln(`\nUninstall failed: ${(err as Error).message}`)
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

  case 'monitor':
    monitor().catch((err) => {
      writeln(`\nMonitor failed: ${(err as Error).message}`)
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
      case 'mute':
        callMute().catch((err) => {
          writeln(`\nCall mute failed: ${(err as Error).message}`)
          process.exit(1)
        })
        break
      case 'unmute':
        callUnmute().catch((err) => {
          writeln(`\nCall unmute failed: ${(err as Error).message}`)
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
        writeln('  mute        Mute the call session')
        writeln('  unmute      Unmute the call session')
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
    writeln('  install         Global setup (deps, models, skills, PATH)')
    writeln('  init            Per-project setup (.mcp.json for display channel)')
    writeln('  uninstall       Remove claude-call and all data (--dry-run to preview)')
    writeln('  check           Verify dependencies and models')
    writeln('  monitor         Interactive status panel (TUI)')
    writeln('  serve           Start MCP channel server (used by Claude Code)')
    writeln('  call start      Start a voice call session')
    writeln('  call stop       Stop the current call session')
    writeln('  call mute       Mute the call session')
    writeln('  call unmute     Unmute the call session')
    writeln('  call status     Show call session status')
    writeln()
    writeln('Quick start:')
    writeln('  claude-call install    # once, global')
    writeln('  claude-call init       # per project')
    writeln('  eld                    # start Claude + voice')
    writeln()
    break
}

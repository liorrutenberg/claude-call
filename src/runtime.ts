/**
 * Per-run state management for call sessions.
 *
 * Manages runtime directories, lock files, and status for isolated call sessions.
 * Each project gets its own run directory at <dataDir>/runs/<project-hash>/
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  openSync,
  closeSync,
  constants,
} from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.js'

// ─── Types ──────────────────────────────────────────────────

export type CallStatus = 'running' | 'muted' | 'crashed' | 'stopped'

export interface StatusFile {
  status: CallStatus
  callPid: number
  claudePid: number
  startedAt: string
  projectRoot: string
  sessionId: string
}

/**
 * Global voice lock structure.
 * Only one voice session can be active at a time (mic is shared).
 */
export interface VoiceLock {
  runDir: string
  projectRoot: string
  pid: number
  sessionId: string
  startedAt: string
}

// ─── Path helpers ───────────────────────────────────────────

/**
 * Get the runs directory, respecting user config.
 */
function getRunsDir(): string {
  return join(loadConfig().dataDir, 'runs')
}

/**
 * Canonicalize a path to handle symlinks (e.g., /tmp vs /private/tmp on macOS).
 */
function canonicalizePath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // Path doesn't exist yet, return as-is
    return path
  }
}

/**
 * Hash a project root path to a short, filesystem-safe identifier.
 * Canonicalizes the path first to handle symlinks.
 */
export function getProjectHash(projectRoot: string): string {
  const canonical = canonicalizePath(projectRoot)
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12)
}

/**
 * Get the per-run directory for a project.
 */
export function getRunDir(projectRoot: string): string {
  return join(getRunsDir(), getProjectHash(projectRoot))
}

/**
 * Get the run directory from environment, or null if not set.
 */
export function getRunDirFromEnv(): string | null {
  return process.env.CLAUDE_CALL_RUN_DIR ?? null
}

// ─── Per-run file paths ─────────────────────────────────────

export function getLockPath(runDir: string): string {
  return join(runDir, 'lock')
}

export function getStatusPath(runDir: string): string {
  return join(runDir, 'status.json')
}

export function getFifoPath(runDir: string): string {
  return join(runDir, 'fifo')
}

export function getStopPath(runDir: string): string {
  return join(runDir, 'stop')
}

export function getMutePath(runDir: string): string {
  return join(runDir, 'mute')
}

// ─── Legacy global paths (backward compatibility) ───────────

const LEGACY_STOP_FILE = '/tmp/claude-call-stop'

/**
 * Get the stop signal file path.
 * Uses per-run path if CLAUDE_CALL_RUN_DIR is set, else falls back to global.
 */
export function getStopFilePath(): string {
  const runDir = getRunDirFromEnv()
  return runDir ? getStopPath(runDir) : LEGACY_STOP_FILE
}

/**
 * Get the mute signal file path.
 * Uses per-run path if CLAUDE_CALL_RUN_DIR is set.
 */
export function getMuteFilePath(): string | null {
  const runDir = getRunDirFromEnv()
  return runDir ? getMutePath(runDir) : null
}

// ─── Directory management ───────────────────────────────────

/**
 * Ensure the run directory exists.
 */
export function ensureRunDir(runDir: string): void {
  mkdirSync(runDir, { recursive: true })
}

/**
 * Clean up a run directory entirely.
 * Refuses to clean if lock is held by a live process.
 *
 * @returns true if cleaned, false if refused due to live lock
 */
export function cleanupRunDir(runDir: string): boolean {
  if (!existsSync(runDir)) return true

  // Safety check: don't clean if lock is held by a live process
  if (isLockHeld(runDir)) {
    return false
  }

  rmSync(runDir, { recursive: true, force: true })
  return true
}

// ─── Lock file management ───────────────────────────────────

/**
 * Check if a process is alive.
 * Returns true for PID <= 0 as invalid, handles EPERM (alive but no permission).
 */
function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means process exists but we can't signal it
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      return true
    }
    // ESRCH means no such process
    return false
  }
}

/**
 * Read the PID from a lock file.
 * @returns the PID or null if unreadable/invalid
 */
function readLockPid(lockPath: string): number | null {
  try {
    const content = readFileSync(lockPath, 'utf-8').trim()
    const pid = parseInt(content, 10)
    return (!isNaN(pid) && pid > 0) ? pid : null
  } catch {
    return null
  }
}

/**
 * Acquire an exclusive lock for the run directory.
 *
 * Uses the safe pattern: try O_EXCL first, on EEXIST check if stale, retry once.
 *
 * @param runDir - The run directory to lock
 * @param pid - The PID to write to the lock file
 * @returns true if lock acquired, false if another live session holds the lock
 */
export function acquireLock(runDir: string, pid: number): boolean {
  ensureRunDir(runDir)
  const lockPath = getLockPath(runDir)

  // First attempt: try to create lock atomically
  const tryCreate = (): boolean => {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY)
      writeFileSync(fd, String(pid))
      closeSync(fd)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return false
      }
      throw err
    }
  }

  if (tryCreate()) {
    return true
  }

  // Lock exists - check if stale
  const existingPid = readLockPid(lockPath)
  if (existingPid !== null && isProcessAlive(existingPid)) {
    // Lock is held by a live process
    return false
  }

  // Stale lock - remove and retry once
  try {
    unlinkSync(lockPath)
  } catch {
    // Another process may have removed it, continue to retry
  }

  return tryCreate()
}

/**
 * Release the lock file.
 * Only releases if the lock is owned by the specified PID.
 *
 * @param runDir - The run directory
 * @param pid - The PID that should own the lock (defaults to current process)
 */
export function releaseLock(runDir: string, pid: number = process.pid): void {
  const lockPath = getLockPath(runDir)
  try {
    const lockPid = readLockPid(lockPath)
    if (lockPid === pid) {
      unlinkSync(lockPath)
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Check if a lock exists and the owning process is alive.
 */
export function isLockHeld(runDir: string): boolean {
  const lockPath = getLockPath(runDir)
  const pid = readLockPid(lockPath)
  return pid !== null && isProcessAlive(pid)
}

/**
 * Get the PID of the process holding the lock, or null if not held.
 */
export function getLockHolder(runDir: string): number | null {
  const lockPath = getLockPath(runDir)
  const pid = readLockPid(lockPath)
  if (pid !== null && isProcessAlive(pid)) {
    return pid
  }
  return null
}

// ─── Global voice lock ──────────────────────────────────────

/**
 * Get the path to the global voice lock file.
 * Only one voice session can be active at a time (mic is shared).
 */
export function getVoiceLockPath(): string {
  return join(loadConfig().dataDir, 'voice.lock')
}

/**
 * Read the global voice lock file.
 * @returns VoiceLock if valid lock exists with live process, null otherwise
 */
export function readVoiceLock(): VoiceLock | null {
  const lockPath = getVoiceLockPath()
  try {
    const content = readFileSync(lockPath, 'utf-8')
    const lock = JSON.parse(content) as VoiceLock
    // Validate required fields
    if (!lock.runDir || !lock.pid || !lock.sessionId) {
      return null
    }
    // Check if process is alive
    if (!isProcessAlive(lock.pid)) {
      return null
    }
    return lock
  } catch {
    return null
  }
}

/**
 * Write the global voice lock file atomically.
 */
function writeVoiceLock(lock: VoiceLock): void {
  const lockPath = getVoiceLockPath()
  const tempPath = `${lockPath}.tmp.${process.pid}`
  writeFileSync(tempPath, JSON.stringify(lock, null, 2))
  renameSync(tempPath, lockPath)
}

/**
 * Acquire the global voice lock.
 * Uses atomic O_CREAT|O_EXCL pattern with stale lock cleanup.
 *
 * @param lock - The lock data to write
 * @returns true if lock acquired, false if another live session holds it
 */
export function acquireVoiceLock(lock: VoiceLock): boolean {
  const lockPath = getVoiceLockPath()

  // Ensure data dir exists
  const dataDir = loadConfig().dataDir
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }

  // First attempt: try to create lock atomically
  const tryCreate = (): boolean => {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY)
      writeFileSync(fd, JSON.stringify(lock, null, 2))
      closeSync(fd)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return false
      }
      throw err
    }
  }

  if (tryCreate()) {
    return true
  }

  // Lock exists - check if stale
  const existingLock = readVoiceLock()
  if (existingLock !== null) {
    // Lock is held by a live process
    return false
  }

  // Stale lock - remove and retry once
  try {
    unlinkSync(lockPath)
  } catch {
    // Another process may have removed it, continue to retry
  }

  return tryCreate()
}

/**
 * Release the global voice lock.
 * Only releases if the lock's PID matches exactly.
 *
 * @param pid - The PID that should own the lock
 */
export function releaseVoiceLock(pid: number): void {
  const lockPath = getVoiceLockPath()
  try {
    // Read raw content to check ownership without process liveness check
    const content = readFileSync(lockPath, 'utf-8')
    const lock = JSON.parse(content) as VoiceLock
    // Only delete if we positively own this lock
    if (lock.pid === pid) {
      unlinkSync(lockPath)
    }
  } catch {
    // File doesn't exist or invalid - nothing to release
  }
}

/**
 * Update the PID in the global voice lock.
 * Used when transferring ownership from launcher to claude process.
 *
 * @param oldPid - The current owner's PID
 * @param newPid - The new owner's PID
 * @returns true if updated, false if lock not found or wrong owner
 */
export function updateVoiceLockPid(oldPid: number, newPid: number): boolean {
  const lock = readVoiceLock()
  // Allow update even if oldPid is dead (stale lock cleanup case)
  if (lock === null) {
    // Try reading raw content to get lock even if process died
    const lockPath = getVoiceLockPath()
    try {
      const content = readFileSync(lockPath, 'utf-8')
      const rawLock = JSON.parse(content) as VoiceLock
      if (rawLock.pid === oldPid) {
        writeVoiceLock({ ...rawLock, pid: newPid })
        return true
      }
    } catch {
      return false
    }
    return false
  }
  if (lock.pid !== oldPid) {
    return false
  }
  writeVoiceLock({ ...lock, pid: newPid })
  return true
}

/**
 * Get the active session's run directory from the global voice lock.
 * @returns runDir if active session exists, null otherwise
 */
export function resolveActiveRunDir(): string | null {
  const lock = readVoiceLock()
  return lock?.runDir ?? null
}

/**
 * Get the active session info from the global voice lock.
 * @returns VoiceLock if active session exists, null otherwise
 */
export function resolveActiveSession(): VoiceLock | null {
  return readVoiceLock()
}

// ─── Status file management ─────────────────────────────────

/**
 * Write the status file atomically (write to temp + rename).
 */
export function writeStatus(runDir: string, status: StatusFile): void {
  ensureRunDir(runDir)
  const statusPath = getStatusPath(runDir)
  const tempPath = `${statusPath}.tmp.${process.pid}`

  writeFileSync(tempPath, JSON.stringify(status, null, 2))
  renameSync(tempPath, statusPath)
}

/**
 * Read the status file.
 */
export function readStatus(runDir: string): StatusFile | null {
  const statusPath = getStatusPath(runDir)
  if (!existsSync(statusPath)) return null
  try {
    const content = readFileSync(statusPath, 'utf-8')
    return JSON.parse(content) as StatusFile
  } catch {
    return null
  }
}

/**
 * Update specific fields in the status file.
 */
export function updateStatus(runDir: string, updates: Partial<StatusFile>): void {
  const current = readStatus(runDir)
  if (!current) return
  writeStatus(runDir, { ...current, ...updates })
}

// ─── Signal file helpers (explicit runDir) ──────────────────

/**
 * Set the stop signal for a specific run directory.
 */
export function setStopSignalIn(runDir: string): void {
  ensureRunDir(runDir)
  try {
    writeFileSync(getStopPath(runDir), `stop at ${new Date().toISOString()}`)
  } catch {
    // Ignore errors
  }
}

/**
 * Clear the stop signal for a specific run directory.
 */
export function clearStopSignalIn(runDir: string): void {
  const path = getStopPath(runDir)
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // Ignore errors
  }
}

/**
 * Check if stop signal is set for a specific run directory.
 */
export function hasStopSignalIn(runDir: string): boolean {
  return existsSync(getStopPath(runDir))
}

/**
 * Set the mute signal for a specific run directory.
 */
export function setMuteSignalIn(runDir: string): void {
  ensureRunDir(runDir)
  try {
    writeFileSync(getMutePath(runDir), `mute at ${new Date().toISOString()}`)
  } catch {
    // Ignore errors
  }
}

/**
 * Clear the mute signal for a specific run directory.
 */
export function clearMuteSignalIn(runDir: string): void {
  const path = getMutePath(runDir)
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // Ignore errors
  }
}

/**
 * Check if mute signal is set for a specific run directory.
 */
export function hasMuteSignalIn(runDir: string): boolean {
  return existsSync(getMutePath(runDir))
}

// ─── Signal file helpers (env-driven, for recorder.ts compat) ─

/**
 * Check if stop signal is set.
 * Uses CLAUDE_CALL_RUN_DIR if set, else legacy global path.
 */
export function hasStopSignal(): boolean {
  return existsSync(getStopFilePath())
}

/**
 * Set the stop signal.
 * Uses CLAUDE_CALL_RUN_DIR if set, else legacy global path.
 */
export function setStopSignal(): void {
  const runDir = getRunDirFromEnv()
  if (runDir) {
    setStopSignalIn(runDir)
  } else {
    try {
      writeFileSync(LEGACY_STOP_FILE, `stop at ${new Date().toISOString()}`)
    } catch {
      // Ignore errors
    }
  }
}

/**
 * Clear the stop signal.
 * Uses CLAUDE_CALL_RUN_DIR if set, else legacy global path.
 */
export function clearStopSignal(): void {
  const path = getStopFilePath()
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // Ignore errors
  }
}

/**
 * Check if mute signal is set.
 * Uses CLAUDE_CALL_RUN_DIR if set.
 */
export function hasMuteSignal(): boolean {
  const path = getMuteFilePath()
  return path !== null && existsSync(path)
}

/**
 * Set the mute signal.
 * Uses CLAUDE_CALL_RUN_DIR if set.
 */
export function setMuteSignal(): void {
  const runDir = getRunDirFromEnv()
  if (runDir) {
    setMuteSignalIn(runDir)
  }
}

/**
 * Clear the mute signal.
 * Uses CLAUDE_CALL_RUN_DIR if set.
 */
export function clearMuteSignal(): void {
  const path = getMuteFilePath()
  if (path === null) return
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // Ignore errors
  }
}

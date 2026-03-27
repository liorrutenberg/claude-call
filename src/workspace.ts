/**
 * Shared workspace for call-to-main session communication.
 *
 * Location: <projectRoot>/.exo-call/
 *
 * Contents:
 * - session.json   — current call session info (copied from runtime status)
 * - inbox.jsonl    — append-only event log (call → main communication)
 * - artifacts/     — directory for human-readable output files
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

// ─── Types ──────────────────────────────────────────────────

export interface InboxEvent {
  ts: string
  type: 'artifact' | 'message' | 'status' | 'result'
  content: string
  metadata?: Record<string, unknown>
}

export interface InboxEventInput {
  type: InboxEvent['type']
  content: string
  metadata?: Record<string, unknown>
}

// ─── Path helpers ───────────────────────────────────────────

const WORKSPACE_DIR = '.exo-call'

/**
 * Get the workspace path for a project.
 */
export function getWorkspacePath(projectRoot: string): string {
  return join(projectRoot, WORKSPACE_DIR)
}

function getInboxPath(workspacePath: string): string {
  return join(workspacePath, 'inbox.jsonl')
}

function getArtifactsDir(workspacePath: string): string {
  return join(workspacePath, 'artifacts')
}

function getSessionPath(workspacePath: string): string {
  return join(workspacePath, 'session.json')
}

// ─── Workspace initialization ───────────────────────────────

/**
 * Initialize workspace directory.
 * Creates the directory structure and cleans stale files.
 *
 * @param projectRoot - The project root directory
 * @returns The workspace path
 */
export function initWorkspace(projectRoot: string): string {
  const workspacePath = getWorkspacePath(projectRoot)

  // Create directory structure
  mkdirSync(workspacePath, { recursive: true })
  mkdirSync(getArtifactsDir(workspacePath), { recursive: true })

  // Clean stale files from previous sessions
  const inboxPath = getInboxPath(workspacePath)
  if (existsSync(inboxPath)) {
    rmSync(inboxPath, { force: true })
  }

  const sessionPath = getSessionPath(workspacePath)
  if (existsSync(sessionPath)) {
    rmSync(sessionPath, { force: true })
  }

  // Clean stale artifacts (optional — keep if user wants to preserve history)
  // For now, we clean them to start fresh each session
  const artifactsDir = getArtifactsDir(workspacePath)
  if (existsSync(artifactsDir)) {
    const files = readdirSync(artifactsDir)
    for (const file of files) {
      rmSync(join(artifactsDir, file), { force: true })
    }
  }

  return workspacePath
}

// ─── Inbox operations ───────────────────────────────────────

/**
 * Append an event to inbox.jsonl.
 * Uses append mode for atomic writes.
 *
 * @param workspacePath - The workspace directory path
 * @param event - The event to append
 */
export function appendInboxEvent(workspacePath: string, event: InboxEventInput): void {
  const inboxPath = getInboxPath(workspacePath)

  const fullEvent: InboxEvent = {
    ts: new Date().toISOString(),
    type: event.type,
    content: event.content,
    ...(event.metadata && { metadata: event.metadata }),
  }

  const line = JSON.stringify(fullEvent) + '\n'

  // Append mode is atomic at the filesystem level for reasonably-sized writes
  appendFileSync(inboxPath, line)
}

/**
 * Read inbox events, optionally filtering by timestamp.
 *
 * @param workspacePath - The workspace directory path
 * @param since - Optional ISO timestamp to filter events after
 * @returns Array of inbox events
 */
export function readInboxEvents(workspacePath: string, since?: string): InboxEvent[] {
  const inboxPath = getInboxPath(workspacePath)

  if (!existsSync(inboxPath)) {
    return []
  }

  try {
    const content = readFileSync(inboxPath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)

    const events: InboxEvent[] = []
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as InboxEvent
        if (since && event.ts <= since) {
          continue
        }
        events.push(event)
      } catch {
        // Skip malformed lines
      }
    }

    return events
  } catch {
    return []
  }
}

// ─── Artifact operations ────────────────────────────────────

/**
 * Write an artifact file.
 *
 * @param workspacePath - The workspace directory path
 * @param name - The artifact filename (should include extension)
 * @param content - The artifact content
 * @returns The full path to the artifact file
 */
export function writeArtifact(workspacePath: string, name: string, content: string): string {
  const artifactsDir = getArtifactsDir(workspacePath)
  mkdirSync(artifactsDir, { recursive: true })

  const artifactPath = join(artifactsDir, name)

  // Use atomic write (temp + rename) for safety
  const tempPath = `${artifactPath}.tmp.${process.pid}`
  writeFileSync(tempPath, content)
  renameSync(tempPath, artifactPath)

  return artifactPath
}

// ─── Session info ───────────────────────────────────────────

/**
 * Write session info to the workspace.
 * This is a copy of runtime status for easy access by main session.
 *
 * @param workspacePath - The workspace directory path
 * @param sessionInfo - Session information to write
 */
export function writeSessionInfo(workspacePath: string, sessionInfo: Record<string, unknown>): void {
  const sessionPath = getSessionPath(workspacePath)

  // Atomic write
  const tempPath = `${sessionPath}.tmp.${process.pid}`
  writeFileSync(tempPath, JSON.stringify(sessionInfo, null, 2))
  renameSync(tempPath, sessionPath)
}

/**
 * Read session info from the workspace.
 *
 * @param workspacePath - The workspace directory path
 * @returns Session info or null if not found
 */
export function readSessionInfo(workspacePath: string): Record<string, unknown> | null {
  const sessionPath = getSessionPath(workspacePath)

  if (!existsSync(sessionPath)) {
    return null
  }

  try {
    const content = readFileSync(sessionPath, 'utf-8')
    return JSON.parse(content) as Record<string, unknown>
  } catch {
    return null
  }
}

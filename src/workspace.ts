/**
 * Shared workspace for call-to-main session communication.
 *
 * Location: <projectRoot>/.claude-call/
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs'
import { join } from 'node:path'

// ─── Path helpers ───────────────────────────────────────────

const WORKSPACE_DIR = '.claude-call'

/**
 * Get the workspace path for a project.
 */
export function getWorkspacePath(projectRoot: string): string {
  return join(projectRoot, WORKSPACE_DIR)
}

// ─── Workspace initialization ───────────────────────────────

/**
 * Initialize workspace directory.
 * Creates the directory structure.
 *
 * @param projectRoot - The project root directory
 * @returns The workspace path
 */
export function initWorkspace(projectRoot: string): string {
  const workspacePath = getWorkspacePath(projectRoot)

  // Create directory structure
  mkdirSync(workspacePath, { recursive: true })

  // Ensure .claude-call/ is in the project's .gitignore
  const gitignorePath = join(projectRoot, '.gitignore')
  try {
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : ''
    if (!existing.includes('.claude-call')) {
      const entry = `${existing.endsWith('\n') || existing === '' ? '' : '\n'}.claude-call/\n`
      appendFileSync(gitignorePath, entry)
    }
  } catch {
    // Ignore — gitignore is nice-to-have, not critical
  }

  return workspacePath
}

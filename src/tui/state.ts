/**
 * State reading for the TUI monitor.
 * Reads status.json and agents.jsonl from the active run directory.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveActiveRunDir } from '../runtime.js'
import type { StatusFile, AgentEvent, AgentEntry, MonitorState } from './types.js'

// Re-export for convenience
export { resolveActiveRunDir }

/**
 * Read status.json from a run directory.
 */
function readStatus(runDir: string): StatusFile | null {
  const statusPath = join(runDir, 'status.json')
  if (!existsSync(statusPath)) return null
  try {
    return JSON.parse(readFileSync(statusPath, 'utf-8')) as StatusFile
  } catch {
    return null
  }
}

/**
 * Parse agents.jsonl and compute agent states.
 */
function readAgents(runDir: string): AgentEntry[] {
  const agentsPath = join(runDir, 'agents.jsonl')
  if (!existsSync(agentsPath)) return []

  const now = Date.now()
  const dispatches = new Map<string, AgentEvent>()
  const completesById = new Map<string, AgentEvent>()
  const completesByName = new Map<string, AgentEvent>()

  try {
    const content = readFileSync(agentsPath, 'utf-8')
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as AgentEvent
        if (event.event === 'dispatch') {
          const key = event.id ?? `${event.name}:${event.ts}`
          dispatches.set(key, event)
        } else if (event.event === 'complete') {
          // Index by id (preferred) and by name (fallback)
          if (event.id) {
            completesById.set(event.id, event)
          }
          completesByName.set(event.name, event)
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    return []
  }

  // Build agent entries - match dispatches to completions
  const agents: AgentEntry[] = []
  const usedCompletes = new Set<string>()

  // Sort dispatches by time (oldest first) so earlier dispatches get matched first
  const sortedDispatches = [...dispatches.values()].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
  )

  for (const dispatch of sortedDispatches) {
    const startedAt = new Date(dispatch.ts)
    const dispatchId = dispatch.id ?? `${dispatch.name}:${dispatch.ts}`

    // Match by id first, fall back to name
    const complete = (dispatch.id && completesById.get(dispatch.id)) || completesByName.get(dispatch.name)
    const completeKey = complete ? (complete.id ?? `${complete.name}:${complete.ts}`) : null

    // Check if this dispatch has a matching complete that hasn't been used
    const hasComplete = complete &&
      new Date(complete.ts) >= startedAt &&
      completeKey &&
      !usedCompletes.has(completeKey)

    if (hasComplete && completeKey) {
      usedCompletes.add(completeKey)
      const completedAt = new Date(complete.ts)
      agents.push({
        name: dispatch.name,
        status: 'done',
        startedAt,
        completedAt,
        elapsedMs: completedAt.getTime() - startedAt.getTime(),
        summary: complete.summary,
      })
    } else {
      agents.push({
        name: dispatch.name,
        status: 'running',
        startedAt,
        elapsedMs: now - startedAt.getTime(),
      })
    }
  }

  // Sort by start time (most recent first)
  agents.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())

  return agents
}

/**
 * Read all monitor state from the active run directory.
 */
export function readMonitorState(): MonitorState {
  const runDir = resolveActiveRunDir()

  if (!runDir) {
    return {
      connected: false,
      runDir: null,
      status: null,
      agents: [],
      uptimeMs: 0,
      agentCounts: { total: 0, active: 0 },
    }
  }

  const status = readStatus(runDir)
  const agents = readAgents(runDir)
  const now = Date.now()
  const uptimeMs = status ? now - new Date(status.startedAt).getTime() : 0

  return {
    connected: true,
    runDir,
    status,
    agents,
    uptimeMs,
    agentCounts: {
      total: agents.length,
      active: agents.filter(a => a.status === 'running').length,
    },
  }
}

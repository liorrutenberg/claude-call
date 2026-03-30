/**
 * Types for the TUI monitor.
 */

export interface StatusFile {
  status: 'running' | 'muted' | 'crashed' | 'stopped'
  callPid: number
  claudePid: number
  startedAt: string
  projectRoot: string
  sessionId: string
}

export interface AgentEvent {
  event: 'dispatch' | 'complete'
  name: string
  ts: string
  id?: string
  summary?: string
}

export interface AgentEntry {
  name: string
  status: 'running' | 'done'
  startedAt: Date
  completedAt?: Date
  elapsedMs: number
  summary?: string
}

export interface MonitorState {
  connected: boolean
  runDir: string | null
  status: StatusFile | null
  agents: AgentEntry[]
  uptimeMs: number
  agentCounts: {
    total: number
    active: number
  }
}

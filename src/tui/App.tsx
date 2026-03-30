import { useState, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import { VoiceStatus } from './VoiceStatus.js'
import { AgentList } from './AgentList.js'
import { AgentDetail } from './AgentDetail.js'
import { SessionInfo } from './SessionInfo.js'
import { SessionLog } from './SessionLog.js'
import { Settings, getSettingsCount, handleSettingsInput } from './Settings.js'
import { readMonitorState } from './state.js'
import { setMuteSignalIn, clearMuteSignalIn, hasMuteSignalIn, updateStatus } from '../runtime.js'
import type { MonitorState } from './types.js'

const POLL_INTERVAL_MS = 1500
const LOG_MAX_HEIGHT = 15

function emptyState(): MonitorState {
  return {
    connected: false,
    runDir: null,
    status: null,
    agents: [],
    uptimeMs: 0,
    claudeSessionId: null,
    logLines: [],
    agentCounts: { total: 0, active: 0 },
  }
}

type ViewMode = 'main' | 'settings' | 'agent' | 'log'

export function App() {
  const [state, setState] = useState<MonitorState>(emptyState)
  const [viewMode, setViewMode] = useState<ViewMode>('main')
  const [settingsIdx, setSettingsIdx] = useState(0)
  const [agentIdx, setAgentIdx] = useState(-1)
  const [logScroll, setLogScroll] = useState(0)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    setState(readMonitorState())
    const interval = setInterval(() => {
      setState(prev => {
        const next = readMonitorState()
        // Auto-scroll to bottom when new lines arrive
        if (autoScroll && next.logLines.length > prev.logLines.length) {
          setLogScroll(Math.max(0, next.logLines.length - LOG_MAX_HEIGHT))
        }
        return next
      })
    }, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [autoScroll])

  useInput((input, key) => {
    // Toggle settings
    if (input === 's') {
      setViewMode(prev => prev === 'settings' ? 'main' : 'settings')
      return
    }

    // Toggle voice log viewer
    if (input === 'v' && state.connected) {
      if (viewMode === 'log') {
        setViewMode('main')
      } else {
        setViewMode('log')
        setAutoScroll(true)
        setLogScroll(Math.max(0, state.logLines.length - LOG_MAX_HEIGHT))
      }
      return
    }

    // Settings navigation
    if (viewMode === 'settings') {
      if (key.escape) {
        setViewMode('main')
        return
      }
      const count = getSettingsCount()
      if (key.upArrow) {
        setSettingsIdx(prev => (prev - 1 + count) % count)
      } else if (key.downArrow) {
        setSettingsIdx(prev => (prev + 1) % count)
      } else if (key.return || key.leftArrow || key.rightArrow) {
        const action = key.return ? 'return' : key.leftArrow ? 'left' : 'right'
        handleSettingsInput(action, settingsIdx)
        setState(readMonitorState())
      }
      return
    }

    // Log viewer scroll
    if (viewMode === 'log') {
      if (key.upArrow) {
        setAutoScroll(false)
        setLogScroll(prev => Math.max(0, prev - 1))
      } else if (key.downArrow) {
        setLogScroll(prev => {
          const next = Math.min(prev + 1, Math.max(0, state.logLines.length - LOG_MAX_HEIGHT))
          if (next >= state.logLines.length - LOG_MAX_HEIGHT) setAutoScroll(true)
          return next
        })
      } else if (key.escape) {
        setViewMode('main')
      }
      return
    }

    // Agent navigation (main mode)
    const agentCount = state.agents.length
    if (agentCount > 0) {
      if (key.upArrow) {
        setAgentIdx(prev => prev <= 0 ? agentCount - 1 : prev - 1)
        return
      } else if (key.downArrow) {
        setAgentIdx(prev => prev >= agentCount - 1 ? 0 : prev + 1)
        return
      } else if (key.return && agentIdx >= 0 && agentIdx < agentCount) {
        setViewMode(prev => prev === 'agent' ? 'main' : 'agent')
        return
      }
    }

    // Escape closes any pane
    if (key.escape) {
      setViewMode('main')
      return
    }

    // Mute toggle
    if (!state.runDir) return
    if (input === 'm') {
      if (hasMuteSignalIn(state.runDir)) {
        clearMuteSignalIn(state.runDir)
        updateStatus(state.runDir, { status: 'running' })
      } else {
        setMuteSignalIn(state.runDir)
        updateStatus(state.runDir, { status: 'muted' })
      }
      setState(readMonitorState())
    }
  })

  const selectedAgent = agentIdx >= 0 && agentIdx < state.agents.length ? state.agents[agentIdx] : null

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>claude-call monitor</Text>
      <Box marginTop={1} />
      <VoiceStatus connected={state.connected} status={state.status} />
      <AgentList agents={state.agents} selectedIndex={agentIdx} />
      <SessionInfo state={state} />
      {viewMode === 'settings' && <Settings selectedIndex={settingsIdx} />}
      {viewMode === 'agent' && selectedAgent && <AgentDetail agent={selectedAgent} />}
      {viewMode === 'log' && (
        <SessionLog lines={state.logLines} scrollOffset={logScroll} maxHeight={LOG_MAX_HEIGHT} />
      )}
      {!state.connected && (
        <Box marginTop={1}>
          <Text dimColor>Waiting for call session...</Text>
        </Box>
      )}
      {viewMode === 'main' && (
        <Box marginTop={1}>
          <Text dimColor>
            {state.connected ? '[m] mute  [s] settings  [v] voice log' : '[s] settings'}
            {state.agents.length > 0 ? '  [\u2191\u2193] agents  [\u23CE] inspect' : ''}
          </Text>
        </Box>
      )}
    </Box>
  )
}

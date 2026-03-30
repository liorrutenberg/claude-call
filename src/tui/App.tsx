import { useState, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import { VoiceStatus } from './VoiceStatus.js'
import { AgentList } from './AgentList.js'
import { AgentDetail } from './AgentDetail.js'
import { SessionInfo } from './SessionInfo.js'
import { Settings, getSettingsCount, handleSettingsInput } from './Settings.js'
import { readMonitorState } from './state.js'
import { setMuteSignalIn, clearMuteSignalIn, hasMuteSignalIn, updateStatus } from '../runtime.js'
import type { MonitorState } from './types.js'

const POLL_INTERVAL_MS = 1500

function emptyState(): MonitorState {
  return {
    connected: false,
    runDir: null,
    status: null,
    agents: [],
    uptimeMs: 0,
    agentCounts: { total: 0, active: 0 },
  }
}

export function App() {
  const [state, setState] = useState<MonitorState>(emptyState)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsIdx, setSettingsIdx] = useState(0)
  const [agentIdx, setAgentIdx] = useState(-1)
  const [viewingAgent, setViewingAgent] = useState(false)

  useEffect(() => {
    setState(readMonitorState())
    const interval = setInterval(() => {
      setState(readMonitorState())
    }, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

  useInput((input, key) => {
    // Toggle settings panel
    if (input === 's') {
      setShowSettings(prev => !prev)
      setViewingAgent(false)
      return
    }

    // Settings navigation when panel is open
    if (showSettings) {
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

    // Agent navigation
    const agentCount = state.agents.length
    if (agentCount > 0) {
      if (key.upArrow) {
        setAgentIdx(prev => prev <= 0 ? agentCount - 1 : prev - 1)
        return
      } else if (key.downArrow) {
        setAgentIdx(prev => prev >= agentCount - 1 ? 0 : prev + 1)
        return
      } else if (key.return && agentIdx >= 0 && agentIdx < agentCount) {
        setViewingAgent(prev => !prev)
        return
      }
    }

    // Escape closes detail pane
    if (key.escape) {
      setViewingAgent(false)
      return
    }

    // Normal mode keybindings
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
      {showSettings && <Settings selectedIndex={settingsIdx} />}
      {viewingAgent && selectedAgent && <AgentDetail agent={selectedAgent} />}
      {!state.connected && (
        <Box marginTop={1}>
          <Text dimColor>Waiting for call session...</Text>
        </Box>
      )}
      {!showSettings && (
        <Box marginTop={1}>
          <Text dimColor>
            {state.connected ? '[m] mute  [s] settings' : '[s] settings'}
            {state.agents.length > 0 ? '  [\u2191\u2193] agents  [\u23CE] inspect' : ''}
          </Text>
        </Box>
      )}
    </Box>
  )
}

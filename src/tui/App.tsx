import { useState, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import { VoiceStatus } from './VoiceStatus.js'
import { AgentList } from './AgentList.js'
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
        // Force re-render with fresh state
        setState(readMonitorState())
      }
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

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>claude-call monitor</Text>
      <Box marginTop={1} />
      <VoiceStatus connected={state.connected} status={state.status} />
      <AgentList agents={state.agents} />
      <SessionInfo state={state} />
      {showSettings && <Settings selectedIndex={settingsIdx} />}
      {!state.connected && (
        <Box marginTop={1}>
          <Text dimColor>Waiting for call session...</Text>
        </Box>
      )}
      {!showSettings && (
        <Box marginTop={1}>
          <Text dimColor>{state.connected ? '[m] mute/unmute  [s] settings' : '[s] settings'}</Text>
        </Box>
      )}
    </Box>
  )
}

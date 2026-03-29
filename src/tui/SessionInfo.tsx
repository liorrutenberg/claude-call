import { Box, Text } from 'ink'
import { basename } from 'node:path'
import type { MonitorState } from './types.js'

interface Props {
  state: MonitorState
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function SessionInfo({ state }: Props) {
  if (!state.connected || !state.status) {
    return null
  }

  const project = basename(state.status.projectRoot)
  const uptime = formatUptime(state.uptimeMs)
  const { total, active } = state.agentCounts

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>-- SESSION --</Text>
      <Box>
        <Text dimColor>  uptime: </Text>
        <Text>{uptime}</Text>
      </Box>
      <Box>
        <Text dimColor>  agents: </Text>
        <Text>{total}</Text>
        {active > 0 && <Text color="yellow"> ({active} active)</Text>}
      </Box>
      <Box>
        <Text dimColor>  project: </Text>
        <Text>{project}</Text>
      </Box>
    </Box>
  )
}

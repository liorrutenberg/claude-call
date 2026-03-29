import { Box, Text } from 'ink'
import type { StatusFile } from './types.js'

interface Props {
  connected: boolean
  status: StatusFile | null
}

export function VoiceStatus({ connected, status }: Props) {
  if (!connected) {
    return (
      <Box>
        <Text dimColor>VOICE: </Text>
        <Text color="gray">no session</Text>
      </Box>
    )
  }

  const voiceState = status?.status ?? 'unknown'
  let color: string
  let label: string

  switch (voiceState) {
    case 'running':
      color = 'green'
      label = 'listening'
      break
    case 'paused':
      color = 'yellow'
      label = 'paused'
      break
    case 'crashed':
      color = 'red'
      label = 'crashed'
      break
    default:
      color = 'gray'
      label = voiceState
  }

  return (
    <Box>
      <Text dimColor>VOICE: </Text>
      <Text color={color}>{label}</Text>
    </Box>
  )
}

import { Box, Text } from 'ink'
import { loadConfig, writeConfig } from '../config.js'

// ─── Setting definitions ───────────────────────────────────

interface ToggleSetting {
  kind: 'toggle'
  label: string
  section: string
  key: string
}

interface SliderSetting {
  kind: 'slider'
  label: string
  section: string
  key: string
  min: number
  max: number
  step: number
  format: (v: number) => string
}

type Setting = ToggleSetting | SliderSetting

const SETTINGS: Setting[] = [
  { kind: 'toggle', label: 'Speaker verification', section: 'speaker', key: 'enabled' },
  { kind: 'slider', label: 'Speaker threshold', section: 'speaker', key: 'threshold', min: 0.1, max: 0.9, step: 0.05, format: v => v.toFixed(2) },
  { kind: 'toggle', label: 'Volume gate', section: 'volumeGate', key: 'enabled' },
  { kind: 'slider', label: 'Volume gate min RMS', section: 'volumeGate', key: 'minRms', min: 0, max: 0.5, step: 0.01, format: v => v.toFixed(2) },
  { kind: 'toggle', label: 'Wake word prefix', section: 'wakeWord', key: 'enabled' },
  { kind: 'slider', label: 'TTS rate', section: 'tts', key: 'rate', min: 0.5, max: 2.0, step: 0.05, format: v => v.toFixed(2) },
]

// ─── Helpers ───────────────────────────────────────────────

function readValue(section: string, key: string): unknown {
  const config = loadConfig()
  const sectionObj = (config as unknown as Record<string, unknown>)[section]
  if (sectionObj && typeof sectionObj === 'object') {
    return (sectionObj as Record<string, unknown>)[key]
  }
  return undefined
}

function writeValue(section: string, key: string, value: unknown): void {
  writeConfig({ [section]: { [key]: value } } as never)
}

// ─── Component ─────────────────────────────────────────────

interface Props {
  selectedIndex: number
}

export function Settings({ selectedIndex }: Props) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>-- SETTINGS --</Text>
      {SETTINGS.map((setting, i) => {
        const selected = i === selectedIndex
        const prefix = selected ? '>' : ' '
        const value = readValue(setting.section, setting.key)

        if (setting.kind === 'toggle') {
          const on = Boolean(value)
          return (
            <Box key={`${setting.section}.${setting.key}`}>
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {prefix} {setting.label}: </Text>
              <Text color={on ? 'green' : 'red'}>{on ? 'ON' : 'OFF'}</Text>
            </Box>
          )
        }

        // slider
        const numVal = typeof value === 'number' ? value : 0
        const barWidth = 10
        const pct = Math.max(0, Math.min(1, (numVal - setting.min) / (setting.max - setting.min)))
        const filled = Math.round(pct * barWidth)
        const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled)
        return (
          <Box key={`${setting.section}.${setting.key}`}>
            <Text color={selected ? 'cyan' : undefined} bold={selected}>
              {prefix} {setting.label}: </Text>
            <Text dimColor>[</Text>
            <Text color="cyan">{bar}</Text>
            <Text dimColor>] </Text>
            <Text>{setting.format(numVal)}</Text>
          </Box>
        )
      })}
      <Box marginTop={1}>
        <Text dimColor>{'  \u2191\u2193 navigate  \u23CE toggle  \u2190\u2192 adjust  [s] close'}</Text>
      </Box>
    </Box>
  )
}

// ─── Input handler (called from App) ───────────────────────

export function getSettingsCount(): number {
  return SETTINGS.length
}

export function handleSettingsInput(
  key: string,
  selectedIndex: number,
): void {
  const setting = SETTINGS[selectedIndex]
  if (!setting) return

  if (key === 'return') {
    if (setting.kind === 'toggle') {
      const current = Boolean(readValue(setting.section, setting.key))
      writeValue(setting.section, setting.key, !current)
    }
  } else if (key === 'left') {
    if (setting.kind === 'slider') {
      const current = typeof readValue(setting.section, setting.key) === 'number'
        ? (readValue(setting.section, setting.key) as number)
        : setting.min
      const next = Math.max(setting.min, current - setting.step)
      writeValue(setting.section, setting.key, Math.round(next * 1000) / 1000)
    }
  } else if (key === 'right') {
    if (setting.kind === 'slider') {
      const current = typeof readValue(setting.section, setting.key) === 'number'
        ? (readValue(setting.section, setting.key) as number)
        : setting.min
      const next = Math.min(setting.max, current + setting.step)
      writeValue(setting.section, setting.key, Math.round(next * 1000) / 1000)
    }
  }
}

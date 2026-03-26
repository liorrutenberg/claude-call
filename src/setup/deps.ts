/**
 * System dependency checker.
 *
 * Checks for required and optional system binaries, returning a structured
 * report with install hints for anything missing.
 */

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

export interface DepResult {
  name: string
  description: string
  required: boolean
  found: boolean
  path?: string
  installHint: string
}

function which(binary: string): string | null {
  const result = spawnSync('which', [binary], {
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  })
  if (result.status === 0) {
    return result.stdout.toString().trim()
  }
  return null
}

function findBinary(names: string[], knownPaths: string[] = []): string | null {
  for (const p of knownPaths) {
    if (existsSync(p)) return p
  }
  for (const name of names) {
    const found = which(name)
    if (found) return found
  }
  return null
}

export function checkDeps(): DepResult[] {
  const results: DepResult[] = []

  // sox / rec — required
  const soxPath = findBinary(['sox'], ['/opt/homebrew/bin/sox', '/usr/local/bin/sox'])
  const recPath = findBinary(['rec'], ['/opt/homebrew/bin/rec', '/usr/local/bin/rec'])
  results.push({
    name: 'sox',
    description: 'Audio recording (rec) and processing',
    required: true,
    found: !!(soxPath && recPath),
    path: soxPath ?? undefined,
    installHint: 'brew install sox',
  })

  // whisper-cli — recommended
  const whisperPath = findBinary(
    ['whisper-cli', 'whisper'],
    ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'],
  )
  results.push({
    name: 'whisper-cli',
    description: 'Speech-to-text (Whisper)',
    required: false,
    found: !!whisperPath,
    path: whisperPath ?? undefined,
    installHint: 'brew install whisper-cpp',
  })

  // piper — optional
  const piperPath = findBinary(['piper'], ['/opt/homebrew/bin/piper', '/usr/local/bin/piper'])
  results.push({
    name: 'piper',
    description: 'Local TTS (fast, offline)',
    required: false,
    found: !!piperPath,
    path: piperPath ?? undefined,
    installHint: 'brew install piper',
  })

  // edge-tts — optional
  const edgePath = findBinary(['edge-tts'])
  results.push({
    name: 'edge-tts',
    description: 'Microsoft neural TTS (free, high quality)',
    required: false,
    found: !!edgePath,
    path: edgePath ?? undefined,
    installHint: 'pip install edge-tts',
  })

  // afplay — macOS audio player (should always be present)
  const afplayPath = findBinary(['afplay'])
  results.push({
    name: 'afplay',
    description: 'Audio playback',
    required: true,
    found: !!afplayPath,
    path: afplayPath ?? undefined,
    installHint: 'Built into macOS — should always be available',
  })

  return results
}

export function formatDepsReport(deps: DepResult[]): string {
  const lines: string[] = []

  for (const dep of deps) {
    const status = dep.found ? '\x1b[32m found\x1b[0m' : (dep.required ? '\x1b[31m missing\x1b[0m' : '\x1b[33m not found\x1b[0m')
    const tag = dep.required ? '[required]' : '[optional]'
    lines.push(`  ${status}  ${dep.name} ${tag}`)
    if (dep.found && dep.path) {
      lines.push(`         ${dep.path}`)
    }
    if (!dep.found) {
      lines.push(`         Install: ${dep.installHint}`)
    }
  }

  return lines.join('\n')
}

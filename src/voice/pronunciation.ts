/**
 * Pronunciation engine — text preprocessing for TTS and vocabulary hints for STT.
 *
 * Loads a YAML dictionary and applies whole-word, case-insensitive replacements.
 * The dictionary is hot-reloadable: re-reads only when the file's mtime changes.
 *
 * Categories in YAML (tech, acronyms, names, etc.) are flattened into a single
 * replacement list. The category headers are purely organizational.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { loadConfig } from '../config.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const BUNDLED_DICT = join(__dir, '..', '..', 'config', 'pronunciation.yaml')

// ─── Types ──────────────────────────────────────────────────

interface PronunciationEntry {
  pattern: RegExp
  replacement: string
}

// ─── State ──────────────────────────────────────────────────

let cachedEntries: PronunciationEntry[] | null = null
let cachedMtime = 0
let cachedPath = ''

// ─── Helpers ────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Flatten a pronunciation YAML into a flat Record<term, pronunciation>.
 * Supports both flat and categorized formats:
 *   flat:       { TypeScript: "Type Script" }
 *   categorized: { tech: { TypeScript: "Type Script" }, acronyms: { SQL: "S Q L" } }
 *
 * @param excludeCategories - Category names to skip (e.g., 'corrections')
 */
function flattenDict(parsed: unknown, excludeCategories?: Set<string>): Record<string, string> {
  const result: Record<string, string> = {}
  if (!parsed || typeof parsed !== 'object') return result

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') {
      result[key] = value
    } else if (typeof value === 'object' && value !== null) {
      if (excludeCategories?.has(key)) continue
      for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
        if (typeof innerValue === 'string') {
          result[innerKey] = innerValue
        }
      }
    }
  }

  return result
}

/**
 * Extract only the 'corrections' category from the parsed YAML.
 * Used for STT post-processing (fixing common Whisper mishearings).
 */
function extractCorrections(parsed: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  if (!parsed || typeof parsed !== 'object') return result

  const obj = parsed as Record<string, unknown>
  const corrections = obj.corrections
  if (!corrections || typeof corrections !== 'object') return result

  for (const [key, value] of Object.entries(corrections as Record<string, unknown>)) {
    if (typeof value === 'string') {
      result[key] = value
    }
  }

  return result
}

function buildEntries(dict: Record<string, string>): PronunciationEntry[] {
  return Object.entries(dict).map(([term, replacement]) => ({
    pattern: new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi'),
    replacement,
  }))
}

function getDictPath(): string {
  const config = loadConfig()
  if (config.pronunciation.file && existsSync(config.pronunciation.file)) {
    return config.pronunciation.file
  }
  return BUNDLED_DICT
}

function loadEntries(): PronunciationEntry[] {
  const path = getDictPath()
  if (!existsSync(path)) return []

  try {
    const stat = statSync(path)
    const mtime = stat.mtimeMs

    if (cachedEntries && mtime === cachedMtime && path === cachedPath) {
      return cachedEntries
    }

    const raw = readFileSync(path, 'utf-8')
    const parsed = parseYaml(raw)
    const dict = flattenDict(parsed, new Set(['corrections']))
    cachedEntries = buildEntries(dict)
    cachedMtime = mtime
    cachedPath = path

    return cachedEntries
  } catch {
    return cachedEntries ?? []
  }
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Get domain terms (original keys) for STT prompt hinting.
 * Returns terms like "TypeScript", "Kubernetes", "SQL" — the YAML keys.
 */
export function getDomainTerms(): string[] {
  const path = getDictPath()
  if (!existsSync(path)) return []

  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = parseYaml(raw)
    return Object.keys(flattenDict(parsed))
  } catch {
    return []
  }
}

/**
 * Apply pronunciation corrections to text before TTS.
 * Whole-word, case-insensitive replacements from the YAML dictionary.
 */
export function applyPronunciation(text: string): string {
  const entries = loadEntries()
  if (entries.length === 0) return text

  let result = text
  for (const { pattern, replacement } of entries) {
    result = result.replace(pattern, replacement)
  }
  return result
}

/**
 * Apply STT corrections to transcribed text — fix common Whisper mishearings.
 * Uses the 'corrections' category from the pronunciation YAML.
 */
export function applySttCorrections(text: string): string {
  const path = getDictPath()
  if (!existsSync(path)) return text

  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = parseYaml(raw)
    const corrections = extractCorrections(parsed)

    let result = text
    for (const [wrong, right] of Object.entries(corrections)) {
      result = result.replace(new RegExp(`\\b${escapeRegex(wrong)}\\b`, 'gi'), right)
    }
    return result
  } catch {
    return text
  }
}

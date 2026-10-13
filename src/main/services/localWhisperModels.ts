/**
 * Finds WhisperKit (Core ML) Whisper models already on this Mac and the
 * whisperstt helper that runs them. Nothing is downloaded here: MacWhisper
 * keeps its WhisperKit models in Application Support, and a folder under
 * Raven's own userData is scanned too so a model can be dropped in by hand.
 */

import { app } from 'electron'
import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { getSetting } from '../store'

export interface LocalWhisperModel {
  /** Folder name, e.g. `openai_whisper-base`. */
  name: string
  path: string
}

const REQUIRED_MODEL_PARTS = ['AudioEncoder.mlmodelc', 'TextDecoder.mlmodelc', 'MelSpectrogram.mlmodelc']

// Best first. Matched as substrings of the folder name.
const MODEL_PREFERENCE = ['large-v3-v20240930', 'large-v3_turbo', 'large-v3', 'large-v2', 'distil', 'medium', 'small', 'base', 'tiny']

function userDataDir(): string | null {
  try {
    return app.getPath('userData')
  } catch {
    return null
  }
}

export function localWhisperModelRoots(): string[] {
  const roots = [
    join(homedir(), 'Library', 'Application Support', 'MacWhisper', 'models', 'whisperkit', 'models', 'argmaxinc', 'whisperkit-coreml'),
  ]
  const userData = userDataDir()
  if (userData) roots.push(join(userData, 'whisper-models'))
  return roots
}

export function isWhisperModelFolder(path: string): boolean {
  return REQUIRED_MODEL_PARTS.every((part) => existsSync(join(path, part)))
}

function preferenceRank(name: string): number {
  const lower = name.toLowerCase()
  const idx = MODEL_PREFERENCE.findIndex((key) => lower.includes(key))
  return idx === -1 ? MODEL_PREFERENCE.length : idx
}

export function listLocalWhisperModels(): LocalWhisperModel[] {
  if (process.platform !== 'darwin') return []
  const models: LocalWhisperModel[] = []
  for (const root of localWhisperModelRoots()) {
    let names: string[]
    try {
      names = readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(root, name)
      if (isWhisperModelFolder(path)) models.push({ name, path })
    }
  }
  return models.sort((a, b) => preferenceRank(a.name) - preferenceRank(b.name) || a.name.localeCompare(b.name))
}

/** The model the next recording will load: the saved choice if it still exists, else the best one found. */
export function resolveLocalWhisperModel(): LocalWhisperModel | null {
  const saved = ((getSetting('whisperModelPath') as string) || '').trim()
  if (saved && isWhisperModelFolder(saved)) return { name: basename(saved), path: saved }
  return listLocalWhisperModels()[0] ?? null
}

export function getWhisperBinaryPath(): string | null {
  if (process.platform !== 'darwin') return null
  const devPath = join(process.cwd(), 'src', 'native', 'swift', 'WhisperSTT', '.build', 'release', 'whisperstt')
  const packagedPath = join(process.resourcesPath ?? '', 'swift', 'whisperstt')
  if (existsSync(devPath)) return devPath
  if (existsSync(packagedPath)) return packagedPath
  return null
}

/** Where the helper caches the small tokenizer file WhisperKit fetches on first use of a model. */
export function whisperTokenizerDir(): string | null {
  const userData = userDataDir()
  return userData ? join(userData, 'whisper-tokenizers') : null
}

export function isLocalWhisperAvailable(): boolean {
  return !!getWhisperBinaryPath() && !!resolveLocalWhisperModel()
}

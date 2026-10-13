/**
 * Camera-housing ("notch") geometry for a display, so the overlay can live
 * in it. Electron has no API for this; the audiocapture helper reads it
 * from NSScreen (`audiocapture --notch-info`).
 */

import { execFile } from 'child_process'
import type { Display } from 'electron'
import { createLogger } from './logger'
import { getAudioCaptureBinaryPath } from './systemAudioNative'

const log = createLogger('Notch')

export interface NotchGeometry {
  /** Left edge of the cutout, in points from the display's left edge. */
  x: number
  width: number
  height: number
}

interface HelperScreen {
  frameX: number
  frameWidth: number
  frameHeight: number
  notchX: number
  notchWidth: number
  notchHeight: number
}

// Notched MacBooks have a menu bar at least this tall; other Macs use 24-25.
const NOTCHED_MENU_BAR_MIN_HEIGHT = 30
// Every notched MacBook so far has a cutout close to this size in points.
const FALLBACK_NOTCH_WIDTH = 185
const FALLBACK_NOTCH_HEIGHT = 32

let cachedScreens: Promise<HelperScreen[] | null> | null = null

function readHelperScreens(): Promise<HelperScreen[] | null> {
  const binaryPath = getAudioCaptureBinaryPath()
  if (!binaryPath) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(binaryPath, ['--notch-info'], { timeout: 3000 }, (err, stdout) => {
      if (err) {
        log.warn('audiocapture --notch-info failed:', err.message)
        resolve(null)
        return
      }
      try {
        const parsed = JSON.parse(stdout) as unknown
        resolve(Array.isArray(parsed) ? (parsed as HelperScreen[]) : null)
      } catch {
        log.warn('Unparseable notch info:', stdout.slice(0, 200))
        resolve(null)
      }
    })
  })
}

/** Screens can be added, removed or rescaled; drop what we measured. */
export function invalidateNotchCache(): void {
  cachedScreens = null
}

export function estimateNotch(display: Pick<Display, 'bounds' | 'workArea' | 'internal'>): NotchGeometry | null {
  const menuBarHeight = display.workArea.y - display.bounds.y
  if (!display.internal || menuBarHeight < NOTCHED_MENU_BAR_MIN_HEIGHT) return null
  return {
    x: Math.round((display.bounds.width - FALLBACK_NOTCH_WIDTH) / 2),
    width: FALLBACK_NOTCH_WIDTH,
    height: Math.min(FALLBACK_NOTCH_HEIGHT, menuBarHeight),
  }
}

export function matchHelperScreen(
  display: Pick<Display, 'bounds'>,
  screens: readonly HelperScreen[],
): NotchGeometry | null {
  const match = screens.find((s) =>
    Math.round(s.frameX) === display.bounds.x
    && Math.round(s.frameWidth) === display.bounds.width
    && Math.round(s.frameHeight) === display.bounds.height,
  )
  if (!match || match.notchWidth <= 0 || match.notchHeight <= 0) return null
  return { x: Math.round(match.notchX), width: Math.round(match.notchWidth), height: Math.round(match.notchHeight) }
}

export async function getNotchForDisplay(display: Display): Promise<NotchGeometry | null> {
  if (process.platform !== 'darwin') return null
  if (!cachedScreens) cachedScreens = readHelperScreens()
  const screens = await cachedScreens
  // The helper is authoritative when it ran: a screen it lists without a
  // cutout has none, whatever the menu bar height suggests.
  if (screens) return matchHelperScreen(display, screens)
  return estimateNotch(display)
}

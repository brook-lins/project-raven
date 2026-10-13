import { describe, it, expect, vi } from 'vitest'

vi.mock('../systemAudioNative', () => ({ getAudioCaptureBinaryPath: () => null }))
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import { estimateNotch, matchHelperScreen } from '../notch'

const bounds = { x: 0, y: 0, width: 1512, height: 982 }

describe('matchHelperScreen', () => {
  const screens = [
    { frameX: 0, frameWidth: 1512, frameHeight: 982, notchX: 663, notchWidth: 185, notchHeight: 32 },
    { frameX: 1512, frameWidth: 2560, frameHeight: 1440, notchX: 0, notchWidth: 0, notchHeight: 0 },
  ]

  it('returns the cutout of the screen with the same frame', () => {
    expect(matchHelperScreen({ bounds }, screens)).toEqual({ x: 663, width: 185, height: 32 })
  })

  it('returns null for a screen without a cutout', () => {
    expect(matchHelperScreen({ bounds: { x: 1512, y: 0, width: 2560, height: 1440 } }, screens)).toBeNull()
  })

  it('returns null when no screen matches', () => {
    expect(matchHelperScreen({ bounds: { x: 0, y: 0, width: 1728, height: 1117 } }, screens)).toBeNull()
  })
})

describe('estimateNotch', () => {
  it('centres a default-sized cutout on a built-in display with a tall menu bar', () => {
    expect(estimateNotch({ bounds, workArea: { x: 0, y: 33, width: 1512, height: 874 }, internal: true }))
      .toEqual({ x: 664, width: 185, height: 32 })
  })

  it('assumes no cutout on an external display', () => {
    expect(estimateNotch({ bounds, workArea: { x: 0, y: 38, width: 1512, height: 874 }, internal: false })).toBeNull()
  })

  it('assumes no cutout when the menu bar is the classic height', () => {
    expect(estimateNotch({ bounds, workArea: { x: 0, y: 25, width: 1512, height: 900 }, internal: true })).toBeNull()
  })
})

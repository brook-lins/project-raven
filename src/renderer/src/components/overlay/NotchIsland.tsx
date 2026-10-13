import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { ChevronUp, Eye, EyeOff, Pin } from 'lucide-react'
import ravenLogo from '../../../../../logo/sentral-glyph-white.png'
import incognitoIcon from '../../assets/incognito.svg'

export interface NotchRect {
  x: number
  y: number
  width: number
  height: number
}

interface NotchIslandProps {
  notch: NotchRect
  /** Hit-test target for mouse passthrough: the whole visible island. */
  shellRef: MutableRefObject<HTMLDivElement | null>
  isRecording: boolean
  isStarting: boolean
  stealthEnabled: boolean
  incognitoMode: boolean
  /** The body is the tall panel (transcript / responses) rather than just the ask row. */
  expanded: boolean
  /** Bumped by the parent when something needs the user's eyes (a new response). Opens and pins. */
  attention: number
  onToggleRecording: () => void
  onToggleStealth: () => void
  onToggleIncognito: () => void
  onHide: () => void
  onOpenDashboard: () => void
  children: ReactNode
}

// Space either side of the cutout while a session runs with the island closed.
// Kept as narrow as the timer allows: this strip sits over the menu bar, and
// status icons can start within ~70pt of the cutout.
const LIVE_WING_WIDTH = 62
const OPEN_WIDTH_IDLE = 500
const OPEN_WIDTH_EXPANDED = 580
const EXPANDED_BODY_HEIGHT = 440
const SCREEN_MARGIN = 24
// Matches the hardware cutout's lower corners closely enough to disappear into it.
const CLOSED_RADIUS = 10
const OPEN_RADIUS = 24
const SHOULDER = 8

const HOVER_OPEN_DELAY_MS = 90
const HOVER_CLOSE_DELAY_MS = 320

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/**
 * Overlay shell that lives in the MacBook camera cutout. Closed, it is the
 * cutout itself (plus two small wings while a session runs); hover or a pin
 * drops the panel down out of it.
 */
export function NotchIsland({
  notch,
  shellRef,
  isRecording,
  isStarting,
  stealthEnabled,
  incognitoMode,
  expanded,
  attention,
  onToggleRecording,
  onToggleStealth,
  onToggleIncognito,
  onHide,
  onOpenDashboard,
  children,
}: NotchIslandProps) {
  const reduceMotion = useReducedMotion()
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const live = isRecording || isStarting
  const open = hovered || pinned || focusWithin

  const setHoverSoon = useCallback((value: boolean) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(
      () => setHovered(value),
      value ? HOVER_OPEN_DELAY_MS : HOVER_CLOSE_DELAY_MS,
    )
  }, [])

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
  }, [])

  useEffect(() => {
    if (attention > 0) setPinned(true)
  }, [attention])

  // A pin only makes sense while there is a panel to hold open.
  useEffect(() => {
    if (!expanded) setPinned(false)
  }, [expanded])

  useEffect(() => {
    if (!isRecording) {
      setStartedAt(null)
      return
    }
    let cancelled = false
    setStartedAt(Date.now())
    window.raven.audioGetState()
      .then((state) => { if (!cancelled) setStartedAt(Date.now() - (state.duration || 0)) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [isRecording])

  useEffect(() => {
    if (startedAt === null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const openWidth = Math.min(expanded ? OPEN_WIDTH_EXPANDED : OPEN_WIDTH_IDLE, viewport.width - SCREEN_MARGIN * 2)
  const closedWidth = live ? notch.width + LIVE_WING_WIDTH * 2 : notch.width
  const width = open ? openWidth : closedWidth
  const bodyHeight = Math.max(200, Math.min(EXPANDED_BODY_HEIGHT, viewport.height - notch.height - 160))
  const height: number | 'auto' = !open ? notch.height : expanded ? notch.height + bodyHeight : 'auto'
  const radius = open ? OPEN_RADIUS : CLOSED_RADIUS
  const centerX = notch.x + notch.width / 2

  const wingEdge = `calc(50% + ${notch.width / 2}px)`
  const elapsed = startedAt === null ? null : formatElapsed(now - startedAt)
  // At rest the island is exactly the hardware cutout, which has no shoulders of its own.
  const shoulderOpacity = open || live ? 1 : 0

  return (
    <div
      className="absolute flex justify-center pointer-events-none"
      style={{ top: notch.y, left: centerX, width: 0, WebkitAppRegion: 'no-drag' } as CSSProperties}
    >
      <motion.div
        ref={shellRef}
        className="notch-island relative shrink-0 pointer-events-auto"
        initial={false}
        animate={{ width, height }}
        transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 430, damping: 38, mass: 0.9 }}
        onMouseEnter={() => setHoverSoon(true)}
        onMouseLeave={() => setHoverSoon(false)}
        onFocusCapture={() => setFocusWithin(true)}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false)
        }}
        style={{
          filter: open ? 'drop-shadow(0 14px 28px rgba(0,0,0,0.42))' : 'none',
          transition: 'filter 240ms ease',
        }}
      >
        {/* Concave shoulders where the island meets the top edge of the screen. */}
        <span aria-hidden="true" className="notch-shoulder" style={{ opacity: shoulderOpacity, left: -SHOULDER, width: SHOULDER, height: SHOULDER, background: `radial-gradient(circle at 0 100%, transparent ${SHOULDER - 0.5}px, #000 ${SHOULDER}px)` }} />
        <span aria-hidden="true" className="notch-shoulder" style={{ opacity: shoulderOpacity, right: -SHOULDER, width: SHOULDER, height: SHOULDER, background: `radial-gradient(circle at 100% 100%, transparent ${SHOULDER - 0.5}px, #000 ${SHOULDER}px)` }} />

        <div
          className="relative h-full overflow-hidden bg-black flex flex-col"
          style={{
            borderBottomLeftRadius: radius,
            borderBottomRightRadius: radius,
            transition: 'border-radius 260ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          {/* Cutout row: the hardware sits in the middle, so only the wings carry UI. */}
          <div className="relative shrink-0" style={{ height: notch.height }}>
            <div
              className="absolute inset-y-0 left-0 flex items-center overflow-hidden"
              style={{ right: wingEdge, paddingLeft: open ? 16 : 12, transition: 'padding 200ms ease' }}
            >
              {live ? (
                <button
                  type="button"
                  onClick={() => setPinned((p) => !p)}
                  className="flex items-center gap-2 h-full text-white/90"
                  aria-label={pinned ? 'Collapse Sentral App' : 'Keep Sentral App open'}
                  title={pinned ? 'Collapse' : 'Keep open'}
                >
                  <span className="relative flex w-2 h-2 shrink-0">
                    {isRecording && <span className="notch-pulse absolute inset-0 rounded-full bg-[#ff453a]" />}
                    <span className={`relative w-2 h-2 rounded-full ${isRecording ? 'bg-[#ff453a]' : 'bg-white/40'}`} />
                  </span>
                  <span className="text-[12px] font-medium tabular-nums tracking-tight whitespace-nowrap">
                    {elapsed ?? 'Starting'}
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onOpenDashboard}
                  className="flex items-center gap-1.5 h-full text-white/80 hover:text-white transition-colors"
                  style={{ opacity: open ? 1 : 0, transition: 'opacity 160ms ease' }}
                  tabIndex={open ? 0 : -1}
                  title="Open Sentral App"
                >
                  <img src={ravenLogo} alt="" className="w-[18px] h-[18px] object-contain" draggable={false} />
                  <span className="text-[12px] font-medium tracking-tight">Sentral App</span>
                </button>
              )}
            </div>

            <div
              className="absolute inset-y-0 right-0 flex items-center justify-end pr-2 overflow-hidden"
              style={{ left: wingEdge }}
            >
              {open ? (
                <div className="flex items-center gap-0.5">
                  {isRecording || isStarting ? (
                    <IslandButton
                      label="Stop session"
                      onClick={onToggleRecording}
                      disabled={isStarting}
                      tone="danger"
                    >
                      {isStarting
                        ? <span className="notch-spinner w-3 h-3 rounded-full border-[1.5px] border-white/25 border-t-white/90" />
                        : <span className="w-[9px] h-[9px] rounded-[2.5px] bg-[#ff453a]" />}
                    </IslandButton>
                  ) : (
                    <button
                      type="button"
                      onClick={onToggleRecording}
                      className="h-[22px] mr-1 px-2.5 flex items-center gap-1.5 rounded-full bg-white text-black text-[11.5px] font-semibold tracking-tight hover:bg-white/90 active:scale-[0.97] transition-all"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-[#ff453a]" />
                      Start
                    </button>
                  )}
                  <IslandButton
                    label={stealthEnabled ? 'Hidden from screen sharing' : 'Visible in screen sharing'}
                    onClick={onToggleStealth}
                    active={stealthEnabled}
                  >
                    {stealthEnabled ? <EyeOff size={14} strokeWidth={2} /> : <Eye size={14} strokeWidth={2} />}
                  </IslandButton>
                  <IslandButton
                    label={incognitoMode ? 'Incognito on: session not saved' : 'Incognito off'}
                    onClick={onToggleIncognito}
                    active={incognitoMode}
                  >
                    <img src={incognitoIcon} alt="" width={14} height={14} className={incognitoMode ? 'opacity-100' : 'opacity-60'} />
                  </IslandButton>
                  {expanded && (
                    <IslandButton
                      label={pinned ? 'Unpin: collapse when the pointer leaves' : 'Pin open'}
                      onClick={() => setPinned((p) => !p)}
                      active={pinned}
                    >
                      <Pin size={13} strokeWidth={2} fill={pinned ? 'currentColor' : 'none'} />
                    </IslandButton>
                  )}
                  <IslandButton label="Hide Sentral App" onClick={onHide}>
                    <ChevronUp size={15} strokeWidth={2.25} />
                  </IslandButton>
                </div>
              ) : live ? (
                <div className="flex items-center gap-[2.5px] h-3 pr-1.5" aria-hidden="true">
                  {isRecording
                    ? [0, 1, 2, 3].map((i) => (
                      <span key={i} className="notch-bar w-[2.5px] h-full rounded-full bg-white/85" style={{ animationDelay: `${i * -0.27}s` }} />
                    ))
                    : <span className="notch-spinner w-3 h-3 rounded-full border-[1.5px] border-white/25 border-t-white/90" />}
                </div>
              ) : null}
            </div>
          </div>

          {/* Panel body. Laid out at its open width so text never reflows mid-animation. */}
          <div
            className="flex-1 min-h-0 flex justify-center"
            style={{
              opacity: open ? 1 : 0,
              pointerEvents: open ? 'auto' : 'none',
              transition: open ? 'opacity 200ms ease 70ms' : 'opacity 90ms ease',
            }}
            aria-hidden={!open}
          >
            <div className="shrink-0 flex flex-col min-h-0 pb-1" style={{ width: openWidth }}>
              {children}
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

function IslandButton({
  label,
  onClick,
  active = false,
  disabled = false,
  tone = 'neutral',
  children,
}: {
  label: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  tone?: 'neutral' | 'danger'
  children: ReactNode
}) {
  const idle = tone === 'danger' ? 'bg-[#ff453a]/15 hover:bg-[#ff453a]/25' : 'hover:bg-white/10'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={tone === 'neutral' ? active : undefined}
      title={label}
      className={`w-[26px] h-[22px] flex items-center justify-center rounded-full transition-colors active:scale-[0.94] disabled:opacity-60 ${
        active ? 'bg-white/[0.16] text-white' : `${idle} text-white/60 hover:text-white`
      }`}
    >
      {children}
    </button>
  )
}

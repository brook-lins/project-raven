import sentralGlyph from '../../../../logo/sentral-glyph-black.png'

/** Sentral mark + app name, for light surfaces. `size` is the mark's height in px. */
export function BrandLockup({ size, className = '' }: { size: number; className?: string }) {
  return (
    <span className={`inline-flex items-center text-gray-900 ${className}`} style={{ gap: size * 0.3 }}>
      <img src={sentralGlyph} alt="" style={{ height: size, width: 'auto' }} draggable={false} />
      <span className="font-semibold tracking-tight whitespace-nowrap" style={{ fontSize: size * 0.64, lineHeight: 1 }}>
        Sentral App
      </span>
    </span>
  )
}

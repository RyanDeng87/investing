import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { T } from '../theme'

// Hover info popup rendered through a portal to document.body at a FIXED
// position — always the top layer, never clipped by scrollable/overflow
// containers (the bug that motivated this component).

interface Props {
  width?: number
  children: React.ReactNode
}

export default function InfoTip({ width = 380, children }: Props): React.JSX.Element {
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null)

  const show = (): void => {
    const r = anchorRef.current?.getBoundingClientRect()
    if (!r) return
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 12))
    // Flip below the anchor when there isn't room above.
    const below = r.top < 260
    setPos({ left, top: below ? r.bottom + 8 : r.top - 8, below })
  }

  // Fixed-position coords go stale if an ancestor scrolls/resizes while open —
  // dismiss rather than float detached from the anchor.
  useEffect(() => {
    if (!pos) return
    const dismiss = (): void => setPos(null)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [pos])

  return (
    <span
      ref={anchorRef}
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      style={{
        width: 14,
        height: 14,
        borderRadius: '50%',
        border: `1px solid ${T.muted}`,
        color: T.muted,
        fontSize: 9.5,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'help',
        fontStyle: 'italic',
        fontFamily: 'Georgia, serif',
        flexShrink: 0
      }}
    >
      i
      {pos &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.top,
              transform: pos.below ? undefined : 'translateY(-100%)',
              zIndex: 1000,
              width,
              background: '#262b36',
              border: `1px solid ${T.border}`,
              borderRadius: 8,
              padding: '10px 12px',
              fontSize: 11.5,
              lineHeight: 1.55,
              color: T.text,
              boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
              pointerEvents: 'none'
            }}
          >
            {children}
          </div>,
          document.body
        )}
    </span>
  )
}

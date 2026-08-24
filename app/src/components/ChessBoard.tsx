import { useEffect, useRef } from 'react'
import { Chessground } from '@lichess-org/chessground'
import type { Api } from '@lichess-org/chessground/api'
import type { Config } from '@lichess-org/chessground/config'
import type { Key } from '@lichess-org/chessground/types'

interface ChessBoardProps {
  config: Config
  onMove?: (orig: Key, dest: Key) => void
  onReady?: (api: Api) => void
}

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const RANKS = ['8', '7', '6', '5', '4', '3', '2', '1']

function Coords({ orientation }: { orientation: 'white' | 'black' }) {
  const files = orientation === 'white' ? FILES : [...FILES].reverse()
  const ranks = orientation === 'white' ? RANKS : [...RANKS].reverse()

  return (
    <>
      {/* Rank numbers — left edge. Even i = dark square (needs light label). */}
      {ranks.map((r, i) => (
        <span
          key={r}
          className={i % 2 === 0 ? 'board-coord on-dark-sq' : 'board-coord on-light-sq'}
          style={{
            position: 'absolute',
            left: 2,
            top: `${(i / 8) * 100}%`,
            height: '12.5%',
            display: 'flex',
            alignItems: 'center',
            fontSize: 11,
            fontWeight: 600,
            lineHeight: 1,
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        >
          {r}
        </span>
      ))}
      {/* File letters — bottom edge. Odd i = dark square (needs light label). */}
      {files.map((f, i) => (
        <span
          key={f}
          className={i % 2 === 1 ? 'board-coord on-dark-sq' : 'board-coord on-light-sq'}
          style={{
            position: 'absolute',
            bottom: 2,
            left: `${(i / 8) * 100}%`,
            width: '12.5%',
            display: 'flex',
            justifyContent: 'flex-end',
            paddingRight: 3,
            fontSize: 11,
            fontWeight: 600,
            lineHeight: 1,
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        >
          {f}
        </span>
      ))}
    </>
  )
}

export function ChessBoard({ config, onMove, onReady }: ChessBoardProps) {
  const outerRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const cgRef = useRef<Api | null>(null)
  const onMoveRef = useRef(onMove)
  onMoveRef.current = onMove

  const orientation = config.orientation ?? 'white'

  useEffect(() => {
    if (!wrapRef.current) return
    const cg = Chessground(wrapRef.current, {
      ...config,
      coordinates: false,
      events: {
        move: (orig, dest) => onMoveRef.current?.(orig, dest),
      },
    })
    cgRef.current = cg
    onReady?.(cg)
    outerRef.current?.focus({ preventScroll: true })
    return () => cg.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!cgRef.current) return
    cgRef.current.set({ ...config, coordinates: false })
  }, [config])

  // Snap near-miss pointer clicks to the nearest piece within one square width.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return

    const onPointerDown = (e: PointerEvent) => {
      const board = wrap.querySelector('cg-board')
      if (!board) return

      const pieces = board.querySelectorAll<HTMLElement>('piece')
      if (!pieces.length) return

      // If a piece is already selected, this is a destination click — don't snap.
      if (board.querySelector('.selected')) return

      // Check if the click is already inside a piece bounding rect.
      for (const p of pieces) {
        const r = p.getBoundingClientRect()
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          return // already on a piece — let chessground handle it normally
        }
      }

      // Find nearest piece center.
      let nearest: HTMLElement | null = null
      let minDist = Infinity
      let snapX = 0
      let snapY = 0
      for (const p of pieces) {
        const r = p.getBoundingClientRect()
        const cx = (r.left + r.right) / 2
        const cy = (r.top + r.bottom) / 2
        const dist = Math.hypot(e.clientX - cx, e.clientY - cy)
        if (dist < minDist) {
          minDist = dist
          nearest = p
          snapX = cx
          snapY = cy
        }
      }

      if (!nearest) return

      // Snap only if within one square width of the nearest piece.
      const squareSize = board.getBoundingClientRect().width / 8
      if (minDist > squareSize) return

      e.stopPropagation()
      e.preventDefault()
      board.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        button: e.button,
        buttons: e.buttons,
        clientX: snapX,
        clientY: snapY,
        screenX: snapX,
        screenY: snapY,
        movementX: 0,
        movementY: 0,
        pressure: e.pressure || 0.5,
      }))
    }

    wrap.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => wrap.removeEventListener('pointerdown', onPointerDown, { capture: true })
  }, [])

  return (
    <div
      ref={outerRef}
      tabIndex={0}
      style={{ position: 'relative', width: '100%', height: '100%', outline: 'none' }}
    >
      <div ref={wrapRef} style={{ width: '100%', height: '100%' }} />
      <Coords orientation={orientation as 'white' | 'black'} />
    </div>
  )
}

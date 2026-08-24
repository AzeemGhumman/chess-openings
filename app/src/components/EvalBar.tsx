import type { StockfishEval } from '@/hooks/useStockfish'

interface EvalBarProps {
  evaluation: StockfishEval
  height: number           // matches board size
  flipped?: boolean        // when board is flipped, bar labels swap
}

// Convert centipawns to a 0–1 value (0 = black winning, 1 = white winning)
function cpToPercent(cp: number): number {
  // Sigmoid-style scaling: ±500cp ≈ ±85%
  return 1 / (1 + Math.exp(-cp / 320))
}

function formatScore(ev: StockfishEval): string {
  if (ev.mate !== null) {
    return ev.mate > 0 ? `M${ev.mate}` : `M${Math.abs(ev.mate)}`
  }
  if (ev.score === null) return '0.0'
  const abs = Math.abs(ev.score / 100)
  return abs.toFixed(1)
}

export function EvalBar({ evaluation, height, flipped = false }: EvalBarProps) {
  const { score, mate } = evaluation

  // whitePercent: fraction of bar that is white (bottom when normal, top when flipped)
  let whitePercent: number
  if (mate !== null) {
    whitePercent = mate > 0 ? 1 : 0
  } else if (score !== null) {
    whitePercent = cpToPercent(score)
  } else {
    whitePercent = 0.5
  }

  // When board is flipped, white is at the top so the white portion fills from top
  const topPercent = flipped ? whitePercent * 100 : (1 - whitePercent) * 100
  const label = formatScore(evaluation)
  const whiteAdvantage = (mate !== null ? mate > 0 : (score ?? 0) >= 0)
  const labelOnTop = flipped ? whiteAdvantage : !whiteAdvantage

  return (
    <div
      className="shrink-0 relative rounded overflow-hidden border border-gray-200 select-none"
      style={{ width: 16, height }}
    >
      {/* Black portion (top) */}
      <div
        className="absolute inset-x-0 top-0 bg-gray-900 transition-all duration-300"
        style={{ height: `${topPercent}%` }}
      />
      {/* White portion (bottom) */}
      <div
        className="absolute inset-x-0 bottom-0 bg-white transition-all duration-300"
        style={{ height: `${100 - topPercent}%` }}
      />
      {/* Score label */}
      <div
        className="absolute inset-x-0 flex items-center justify-center"
        style={{ top: labelOnTop ? 2 : undefined, bottom: labelOnTop ? undefined : 2 }}
      >
        <span
          className="text-[8px] font-bold leading-none"
          style={{ color: labelOnTop ? 'white' : '#111', writingMode: 'vertical-lr', transform: labelOnTop ? 'rotate(180deg)' : 'none' }}
        >
          {label}
        </span>
      </div>
    </div>
  )
}

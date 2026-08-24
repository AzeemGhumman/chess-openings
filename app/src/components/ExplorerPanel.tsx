import { useState, useMemo } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { caroKannVariations, CaroKannVariation, variationFamilies } from '@/data/caroKann'
import { cn } from '@/lib/utils'

interface ExplorerPanelProps {
  moveLine: string
  variationName: string
  canGoBack: boolean
  canGoForward: boolean
  onBack: () => void
  onForward: () => void
  onJump: (v: CaroKannVariation) => void
}

export function ExplorerPanel({
  moveLine,
  variationName,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onJump,
}: ExplorerPanelProps) {
  const [search, setSearch] = useState('')
  const [activeFamily, setActiveFamily] = useState<string | null>(null)

  const filtered = useMemo(() => {
    let list = caroKannVariations
    if (activeFamily) list = list.filter(v => v.family === activeFamily)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(v => v.name.toLowerCase().includes(q))
    }
    return list
  }, [search, activeFamily])

  return (
    <div className="flex flex-col h-full gap-3 overflow-hidden">
      {/* Navigation controls */}
      <div className="flex items-center gap-1">
        <button
          onClick={onBack}
          disabled={!canGoBack}
          className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-30 transition-colors"
          title="Previous move"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          onClick={onForward}
          disabled={!canGoForward}
          className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-30 transition-colors"
          title="Next move"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <div className="flex-1 min-w-0 ml-1">
          <p className="text-xs font-mono text-gray-500 truncate">{moveLine || 'Starting position'}</p>
        </div>
      </div>

      {/* Current variation name */}
      <div className="px-2 py-1.5 bg-gray-50 rounded text-xs font-medium text-gray-700 leading-tight">
        {variationName}
      </div>

      {/* Search */}
      <input
        type="text"
        placeholder="Search variations..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="w-full text-xs px-2.5 py-1.5 border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-gray-400"
      />

      {/* Family filter chips */}
      <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
        <button
          onClick={() => setActiveFamily(null)}
          className={cn(
            'text-[10px] px-2 py-0.5 rounded-full border transition-colors whitespace-nowrap',
            !activeFamily
              ? 'bg-gray-800 text-white border-gray-800'
              : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400',
          )}
        >
          All
        </button>
        {variationFamilies.filter(f => f !== 'Caro-Kann Defense').map(f => (
          <button
            key={f}
            onClick={() => setActiveFamily(activeFamily === f ? null : f)}
            className={cn(
              'text-[10px] px-2 py-0.5 rounded-full border transition-colors whitespace-nowrap',
              activeFamily === f
                ? 'bg-gray-800 text-white border-gray-800'
                : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400',
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Variation list */}
      <div className="flex-1 overflow-y-auto -mx-1 space-y-0.5">
        {filtered.map((v, i) => (
          <button
            key={i}
            onClick={() => onJump(v)}
            className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-100 transition-colors"
          >
            <span className="text-[10px] font-mono text-gray-400 mr-1.5">{v.eco}</span>
            <span className="text-xs text-gray-700">{v.shortName || v.name}</span>
          </button>
        ))}
      </div>

      <div className="text-[10px] text-gray-400 text-right">{filtered.length} variations</div>
    </div>
  )
}

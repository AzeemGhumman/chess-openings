import { cn } from '@/lib/utils'
import { OPENING_CATALOG } from '@/data/openings'

interface SettingsPanelProps {
  selectedOpeningId: string
  onSelectOpening: (id: string) => void
}

export function SettingsPanel({ selectedOpeningId, onSelectOpening }: SettingsPanelProps) {
  return (
    <div className="flex flex-col gap-6 w-full max-w-sm">

      {/* Opening selection */}
      <section className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/60">
          <h2 className="text-xs font-semibold text-gray-700 dark:text-gray-200">Opening</h2>
          <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">Selected for Explorer and Practice</p>
        </div>
        <div className="p-2 flex flex-col gap-0.5">
          {OPENING_CATALOG.map(entry => (
            <button
              key={entry.id}
              onClick={() => onSelectOpening(entry.id)}
              className={cn(
                'w-full text-left px-3 py-2 rounded text-xs transition-colors flex items-center justify-between gap-2',
                entry.id === selectedOpeningId
                  ? 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800',
              )}
            >
              <span className="font-medium">{entry.name}</span>
              <span className={cn('text-[10px] font-mono shrink-0', entry.id === selectedOpeningId ? 'text-gray-400 dark:text-gray-500' : 'text-gray-400 dark:text-gray-500')}>
                {entry.description}
              </span>
            </button>
          ))}
        </div>
      </section>

    </div>
  )
}

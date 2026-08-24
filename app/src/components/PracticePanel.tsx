import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  PracticePhase,
  NamingState,
} from '@/hooks/usePractice'

interface PracticePanelProps {
  phase: PracticePhase
  score: number
  naming: NamingState | null
  selectedChoice: string | null
  onSelectChoice: (choice: string) => void
  onProceed: () => void
}

// ─── Naming ───────────────────────────────────────────────────────────────────

function NamingPanel({
  naming,
  selectedChoice,
  score,
  onSelectChoice,
  onProceed,
}: Pick<PracticePanelProps, 'naming' | 'selectedChoice' | 'score' | 'onSelectChoice' | 'onProceed'>) {
  if (!naming) return null
  return (
    <div className="w-full flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-700">Which variation did you play?</p>
        <span className="text-[10px] text-gray-400">Score: {score}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        {naming.choices.map(choice => {
          const isSelected  = selectedChoice === choice
          const isCorrect   = choice === naming.correct
          const showFeedback = selectedChoice !== null

          let style = 'border-gray-200 text-gray-700 hover:bg-gray-50 hover:border-gray-400'
          if (showFeedback) {
            if (isCorrect)      style = 'border-green-500 bg-green-50 text-green-800'
            else if (isSelected) style = 'border-red-400 bg-red-50 text-red-700'
            else                 style = 'border-gray-100 text-gray-400'
          }

          return (
            <button
              key={choice}
              onClick={() => !selectedChoice && onSelectChoice(choice)}
              disabled={!!selectedChoice}
              className={cn(
                'w-full px-3 py-2 rounded border text-xs text-left transition-colors leading-snug',
                style,
                !selectedChoice && 'cursor-pointer',
                selectedChoice && 'cursor-default',
              )}
            >
              {choice}
            </button>
          )
        })}
      </div>

      <div className="flex items-center gap-2 pt-0.5">
        {selectedChoice ? (
          <button
            onClick={onProceed}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded bg-gray-900 text-white text-xs font-medium hover:bg-gray-700 transition-colors"
          >
            Continue
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            onClick={onProceed}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded border border-gray-300 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
          >
            Skip
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function PracticePanel(props: PracticePanelProps) {
  const { phase, score, naming, selectedChoice, onSelectChoice, onProceed } = props

  if (phase === 'naming') {
    return (
      <NamingPanel
        naming={naming}
        selectedChoice={selectedChoice}
        score={score}
        onSelectChoice={onSelectChoice}
        onProceed={onProceed}
      />
    )
  }

  return null
}

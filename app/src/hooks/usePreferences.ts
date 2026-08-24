import { useCallback, useState } from 'react'
import { DEFAULT_OPENING_ID } from '@/data/openings'

export interface Preferences {
  explorer: {
    showHints: boolean
    showTable: boolean
    showEval: boolean
    flipped: boolean
  }
  practice: {
    flipped: boolean
  }
  sidebar: {
    open: boolean
  }
  selectedOpeningId: string
}

const STORAGE_KEY = 'chess-openings-prefs'

const DEFAULTS: Preferences = {
  explorer: { showHints: true, showTable: false, showEval: false, flipped: false },
  practice: { flipped: false },
  sidebar: { open: true },
  selectedOpeningId: DEFAULT_OPENING_ID,
}

function load(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const stored = JSON.parse(raw) as Partial<Preferences>
    return {
      explorer: { ...DEFAULTS.explorer, ...stored.explorer },
      practice: { ...DEFAULTS.practice, ...stored.practice },
      sidebar: { ...DEFAULTS.sidebar, ...stored.sidebar },
      selectedOpeningId: stored.selectedOpeningId ?? DEFAULTS.selectedOpeningId,
    }
  } catch {
    return DEFAULTS
  }
}

function save(prefs: Preferences) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)) } catch {}
}

export function usePreferences() {
  const [prefs, setPrefs] = useState<Preferences>(load)

  const update = useCallback(<K extends keyof Omit<Preferences, 'selectedOpeningId'>>(
    section: K,
    values: Partial<Preferences[K]>,
  ) => {
    setPrefs(current => {
      const next = { ...current, [section]: { ...current[section], ...values } }
      save(next)
      return next
    })
  }, [])

  const setSelectedOpeningId = useCallback((id: string) => {
    setPrefs(current => {
      const next = { ...current, selectedOpeningId: id }
      save(next)
      return next
    })
  }, [])

  return { prefs, update, setSelectedOpeningId }
}

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2, Compass, FlipVertical2, Lightbulb, Map as MapIcon, PanelLeftClose,
  PanelLeftOpen, RotateCcw, Settings, Swords, Table2, BarChart2, TrendingUp,
  LogOut, User, X, ChevronDown, Moon, Sun,
} from 'lucide-react'
import { ChessBoard } from '@/components/ChessBoard'
import { EvalBar } from '@/components/EvalBar'
import { InsightsTab, GOOGLE_CLIENT_ID, decodeGoogleCredential, updateUserProfile } from '@/components/InsightsTab'
import { PracticePanel } from '@/components/PracticePanel'
import { SettingsPanel } from '@/components/SettingsPanel'
import { useExplorer } from '@/hooks/useExplorer'
import { usePractice } from '@/hooks/usePractice'
import { usePreferences } from '@/hooks/usePreferences'
import { useTheme } from '@/hooks/useTheme'
import { useStockfish } from '@/hooks/useStockfish'
import { cn } from '@/lib/utils'
import { getOpeningById, loadOpening } from '@/data/openings'
import type React from 'react'
import type { OpeningVariation, MoveNode } from '@/data/openings'
import { loadSession, saveSession, clearSession, broadcastSession } from '@/lib/session'
import type { StoredSession } from '@/lib/session'

// ─── Theme ───────────────────────────────────────────────────────────────────

// ─── Global Auth Widget ───────────────────────────────────────────────────────

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

function SignOutModal({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <Modal onClose={onCancel}>
      <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">Sign out?</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">Are you sure you want to log out of your account?</p>
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-4 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Cancel</button>
        <button onClick={onConfirm} className="px-4 py-2 text-sm rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:bg-gray-700 dark:hover:bg-gray-100 transition-colors">Sign out</button>
      </div>
    </Modal>
  )
}

function ProfileModal({ session, onClose }: { session: StoredSession; onClose: () => void }) {
  const [name, setName] = useState(session.user.name)
  const [chess, setChess] = useState(session.chesscomUsername ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = name !== session.user.name || chess !== (session.chesscomUsername ?? '')

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      await updateUserProfile(session.idToken, name, chess)
      const next: StoredSession = { ...session, user: { ...session.user, name }, chesscomUsername: chess || undefined }
      saveSession(next)
      broadcastSession(next)
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Profile</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><X className="h-4 w-4" /></button>
      </div>
      <div className="flex items-center gap-3 mb-5">
        <img src={session.user.picture} alt="" className="h-12 w-12 rounded-full" referrerPolicy="no-referrer" />
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{session.user.name}</div>
          <div className="text-xs text-gray-400 dark:text-gray-500 truncate">{session.user.email}</div>
        </div>
      </div>
      <div className="space-y-3 mb-5">
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Display name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900/20 dark:focus:ring-white/20"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Chess.com username</label>
          <input
            value={chess}
            onChange={e => setChess(e.target.value)}
            placeholder="your_username"
            className="w-full border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900/20 dark:focus:ring-white/20"
          />
        </div>
      </div>
      {error && <p className="text-xs text-red-500 mb-3">{error}</p>}
      <div className="flex gap-2 justify-end">
        <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Cancel</button>
        <button
          onClick={handleSave}
          disabled={!changed || saving}
          className="px-4 py-2 text-sm rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:bg-gray-700 dark:hover:bg-gray-100 disabled:opacity-40 transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  )
}

function GlobalAuthWidget() {
  const [session, setSession] = useState<StoredSession | null>(() => loadSession())
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [showSignOut, setShowSignOut] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Keep in sync with InsightsTab auth state
  useEffect(() => {
    const handler = (e: Event) => {
      const s = (e as CustomEvent<StoredSession | null>).detail
      setSession(s)
    }
    window.addEventListener('chess-session', handler)
    return () => window.removeEventListener('chess-session', handler)
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dropdownOpen])

  function handleSignOut() {
    setDropdownOpen(false)
    setShowSignOut(true)
  }

  function confirmSignOut() {
    clearSession()
    broadcastSession(null)
    setSession(null)
    setShowSignOut(false)
    window.dispatchEvent(new CustomEvent('chess-signout-request'))
  }

  function handleSignIn(user: import('@/lib/session').GoogleUser, idToken: string) {
    const stored: StoredSession = { user, idToken }
    saveSession(stored)
    broadcastSession(stored)
    setSession(stored)
    // Navigate to insights so InsightsTab can finish the connect flow
    window.location.hash = '/insights'
  }

  if (!session) {
    return (
      <button
        onClick={() => {
          if (!window.google?.accounts?.id) return
          window.google.accounts.id.initialize({
            client_id: GOOGLE_CLIENT_ID,
            callback: ({ credential }: { credential: string }) => {
              try { handleSignIn(decodeGoogleCredential(credential), credential) } catch { /* ignore */ }
            },
          })
          window.google.accounts.id.prompt()
        }}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 hover:border-gray-300 transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        Sign in
      </button>
    )
  }

  return (
    <>
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setDropdownOpen(v => !v)}
          className="flex items-center gap-2 rounded-full px-2 py-1 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        >
          <img src={session.user.picture} alt="" className="h-7 w-7 rounded-full" referrerPolicy="no-referrer" />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300 max-w-[120px] truncate hidden sm:block">{session.user.name}</span>
          <ChevronDown className="h-3.5 w-3.5 text-gray-400 hidden sm:block" />
        </button>
        {dropdownOpen && (
          <div className="absolute right-0 top-full mt-1.5 w-44 bg-white dark:bg-gray-900 rounded-xl shadow-lg border border-gray-100 dark:border-gray-800 py-1 z-40">
            <button
              onClick={() => { setDropdownOpen(false); setShowProfile(true) }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              <User className="h-4 w-4 text-gray-400" />
              Profile
            </button>
            <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
            <button
              onClick={handleSignOut}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        )}
      </div>

      {showSignOut && (
        <SignOutModal onConfirm={confirmSignOut} onCancel={() => setShowSignOut(false)} />
      )}
      {showProfile && (
        <ProfileModal
          session={session}
          onClose={() => { setShowProfile(false); setSession(loadSession()) }}
        />
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function BoardSizer({ children }: { children: (size: number) => React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState(500)

  useEffect(() => {
    if (!ref.current) return
    const obs = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize(Math.floor(Math.min(width, height, 600)))
    })
    obs.observe(ref.current)
    return () => obs.disconnect()
  }, [])

  return (
    <div ref={ref} className="flex-1 flex items-center justify-center w-full min-h-0">
      {children(size)}
    </div>
  )
}

type AppMode = 'explorer' | 'practice' | 'settings' | 'insights'

function formatMoves(sanMoves: string[], fromDepth: number): string {
  const slice = sanMoves.slice(fromDepth)
  if (slice.length === 0) return '—'
  const parts: string[] = []
  for (let i = 0; i < slice.length; i++) {
    const idx = fromDepth + i
    const isWhite = idx % 2 === 0
    const moveNum = Math.floor(idx / 2) + 1
    if (isWhite) parts.push(`${moveNum}.`)
    else if (i === 0) parts.push(`${moveNum}...`)
    parts.push(slice[i])
  }
  return parts.join(' ')
}

const TABLE_HEIGHT = 180

function findKeyDepth(variations: OpeningVariation[], fromDepth: number): number {
  for (let i = fromDepth; ; i++) {
    const vals = new Set(variations.map(v => v.uciMoves[i]))
    if (vals.size > 1) return i
    const [only] = vals
    if (only === undefined) return i
  }
}

function collapseVariations(
  variations: OpeningVariation[],
  depth: number,
): { displayed: OpeningVariation[]; keyDepth: number } {
  if (variations.length === 0) return { displayed: [], keyDepth: depth }
  const keyDepth = findKeyDepth(variations, depth)
  const map = new Map<string | undefined, OpeningVariation>()
  for (const v of variations) {
    const key = v.uciMoves[keyDepth]
    const existing = map.get(key)
    if (!existing || v.uciMoves.length < existing.uciMoves.length) {
      map.set(key, v)
    }
  }
  return { displayed: [...map.values()], keyDepth }
}

function VariationTable({
  variations,
  selected,
  depth,
  onSelect,
}: {
  variations: OpeningVariation[]
  selected: OpeningVariation | null
  depth: number
  onSelect: (v: OpeningVariation) => void
}) {
  const { displayed, keyDepth } = useMemo(() => collapseVariations(variations, depth), [variations, depth])

  return (
    <div
      className="w-full shrink-0 border border-gray-200 dark:border-gray-700 rounded overflow-hidden bg-white dark:bg-gray-900"
      style={{ height: TABLE_HEIGHT }}
    >
      {displayed.length === 0 ? (
        <div className="flex items-center justify-center h-full text-xs text-gray-400 dark:text-gray-500">
          No matching variations
        </div>
      ) : (
        <div className="overflow-y-auto h-full">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="text-left px-2 py-1.5 font-medium text-gray-500 dark:text-gray-400 w-44">Variation</th>
                <th className="text-left px-2 py-1.5 font-medium text-gray-500 dark:text-gray-400">
                  {depth === 0 ? 'Moves' : 'Continuing'}
                </th>
              </tr>
            </thead>
            <tbody>
              {displayed.map(v => {
                const isSelected = selected != null &&
                  v.uciMoves[keyDepth] === selected.uciMoves[keyDepth]
                return (
                  <tr
                    key={v.name}
                    onClick={() => onSelect(v)}
                    className={cn(
                      'cursor-pointer border-b border-gray-100 dark:border-gray-800 last:border-0 transition-colors',
                      isSelected ? 'bg-gray-900 text-white' : 'hover:bg-gray-50 dark:hover:bg-gray-800',
                    )}
                  >
                    <td className={cn('px-2 py-1.5 font-medium whitespace-nowrap', isSelected ? 'text-white' : 'text-gray-700 dark:text-gray-200')}>
                      {v.shortName}
                    </td>
                    <td className={cn('px-2 py-1.5 font-mono whitespace-nowrap', isSelected ? 'text-gray-200' : 'text-gray-500 dark:text-gray-400')}>
                      {formatMoves(v.sanMoves, depth)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function MoveHistory({
  path,
  freePath,
  onGoTo,
  currentIdx: currentIdxProp,
}: {
  path: MoveNode[]
  freePath: { san: string }[]
  onGoTo: (index: number) => void
  currentIdx?: number
}) {
  type Move = { san: string; idx: number; inTree: boolean }
  type Pair = { num: number; white?: Move; black?: Move }

  const pairs: Pair[] = []

  // Opening-tree moves
  for (let i = 1; i < path.length; i++) {
    const isWhite = (i - 1) % 2 === 0
    const moveNum = Math.floor((i - 1) / 2) + 1
    if (isWhite) pairs.push({ num: moveNum, white: { san: path[i].san, idx: i, inTree: true } })
    else pairs[pairs.length - 1].black = { san: path[i].san, idx: i, inTree: true }
  }

  // Free-exploration moves (indices start at path.length)
  for (let i = 0; i < freePath.length; i++) {
    const halfMoves = (path.length - 1) + i
    const isWhite   = halfMoves % 2 === 0
    const moveNum   = Math.floor(halfMoves / 2) + 1
    const combinedIdx = path.length + i
    const entry: Move = { san: freePath[i].san, idx: combinedIdx, inTree: false }
    if (isWhite) {
      pairs.push({ num: moveNum, white: entry })
    } else {
      const last = pairs[pairs.length - 1]
      if (last && !last.black) last.black = entry
      else pairs.push({ num: moveNum, black: entry })
    }
  }

  const totalMoves = path.length - 1 + freePath.length
  const currentIdx = currentIdxProp ?? (totalMoves > 0 ? totalMoves : 0)

  if (pairs.length === 0) {
    return (
      <div className="w-full h-7 flex items-center px-1">
        <span className="text-[11px] text-gray-400 dark:text-gray-600 italic">No moves yet</span>
      </div>
    )
  }

  return (
    <div className="w-full h-7 overflow-x-auto shrink-0">
      <div className="flex items-center gap-0 font-mono text-xs h-full whitespace-nowrap" style={{ width: 'max-content' }}>
        {pairs.map(({ num, white, black }) => (
          <Fragment key={num}>
            <span className="text-gray-400 dark:text-gray-600 px-1 select-none">{num}.</span>
            {white && (
              <button
                onClick={() => onGoTo(white.idx)}
                title={white.inTree ? undefined : 'Free exploration move — click to return to opening'}
                className={cn(
                  'px-1.5 py-0.5 rounded transition-colors',
                  currentIdx === white.idx
                    ? white.inTree ? 'bg-gray-900 text-white' : 'bg-violet-600 text-white'
                    : white.inTree ? 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800' : 'text-violet-500 italic hover:bg-violet-50 dark:hover:bg-violet-900/20',
                )}
              >
                {white.san}
              </button>
            )}
            {black && (
              <button
                onClick={() => onGoTo(black.idx)}
                title={black.inTree ? undefined : 'Free exploration move — click to return to opening'}
                className={cn(
                  'px-1.5 py-0.5 rounded transition-colors',
                  currentIdx === black.idx
                    ? black.inTree ? 'bg-gray-900 text-white' : 'bg-violet-600 text-white'
                    : black.inTree ? 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800' : 'text-violet-500 italic hover:bg-violet-50 dark:hover:bg-violet-900/20',
                )}
              >
                {black.san}
              </button>
            )}
          </Fragment>
        ))}
      </div>
    </div>
  )
}

const VALID_MODES = new Set<AppMode>(['practice', 'explorer', 'settings', 'insights'])

function modeFromHash(): AppMode {
  const hash = window.location.hash.replace(/^#\//, '')
  return VALID_MODES.has(hash as AppMode) ? (hash as AppMode) : 'practice'
}

export default function App() {
  const [mode, setModeState] = useState<AppMode>(modeFromHash)
  const { prefs, update, setSelectedOpeningId } = usePreferences()

  // Keep URL in sync with mode; also set hash on first render if absent
  const setMode = useCallback((next: AppMode) => {
    setModeState(next)
    window.location.hash = `/${next}`
  }, [])

  // Set initial hash if missing, and sync state on back/forward
  useEffect(() => {
    if (!window.location.hash || window.location.hash === '#') {
      window.location.hash = `/${mode}`
    }
    const onHashChange = () => setModeState(modeFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const openingEntry = useMemo(() => getOpeningById(prefs.selectedOpeningId), [prefs.selectedOpeningId])
  const openingData = useMemo(() => loadOpening(openingEntry), [openingEntry])

  const { dark, toggle: toggleTheme } = useTheme()
  const explorer = useExplorer(prefs.explorer.flipped, prefs.explorer.showHints, openingData, openingEntry.name, dark)
  const practice = usePractice(prefs.practice.flipped, openingData, openingEntry.name, dark)

  const evalEnabled = mode === 'explorer' && prefs.explorer.showEval
  const stockfish = useStockfish(evalEnabled ? explorer.currentFen : null, evalEnabled)

  const practiceEvalEnabled = mode === 'practice' && practice.phase === 'naming'
  const practiceEval = useStockfish(practiceEvalEnabled ? practice.currentBrowseFen : null, practiceEvalEnabled)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      if (mode === 'explorer') {
        if (e.key === 'ArrowLeft') explorer.goBack()
        else explorer.goForward()
      } else if (mode === 'practice' && (practice.phase === 'playing' || practice.phase === 'freeplay' || practice.phase === 'naming')) {
        const totalMoves = practice.path.length - 1 + practice.freeplayMoves.length
        if (totalMoves === 0) return
        if (e.key === 'ArrowLeft') {
          const cur = practice.viewIndex ?? totalMoves
          practice.goToMove(cur <= 1 ? 0 : cur - 1)
        } else {
          const cur = practice.viewIndex
          if (cur === null) return  // already at live position
          practice.goToMove(cur >= totalMoves - 1 ? null : cur + 1)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [mode, explorer.goBack, explorer.goForward, practice.phase, practice.viewIndex, practice.path, practice.freeplayMoves, practice.goToMove])

  const MODES: { id: AppMode; label: string; desc: string; icon: React.ReactNode }[] = [
    { id: 'practice', label: 'Practice',  desc: 'Test your knowledge',      icon: <Swords      className="h-4 w-4" /> },
    { id: 'explorer', label: 'Explorer',  desc: 'Navigate variations freely', icon: <MapIcon   className="h-4 w-4" /> },
    { id: 'insights', label: 'Insights',  desc: 'Analyze your games',        icon: <TrendingUp className="h-4 w-4" /> },
    { id: 'settings', label: 'Settings',  desc: openingEntry.name,           icon: <Settings   className="h-4 w-4" /> },
  ]

  const isBoardMode = mode === 'explorer' || mode === 'practice'

  return (
    <div className="flex flex-col h-screen bg-background overflow-hidden">
      {/* Global top bar */}
      <header className="shrink-0 h-10 flex items-center justify-end gap-1 px-3 border-b bg-white dark:bg-gray-900 dark:border-gray-800 z-30">
        <button
          onClick={toggleTheme}
          className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
        <GlobalAuthWidget />
      </header>

      <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex flex-1 overflow-hidden min-h-0">
      {/* Collapsible sidebar */}
      <aside className={cn('hidden sm:flex shrink-0 border-r bg-white dark:bg-gray-900 dark:border-gray-800 flex-col transition-all duration-200', prefs.sidebar.open ? 'sm:w-52' : 'sm:w-12')}>
        <div className={cn('flex shrink-0 h-10 items-center border-b dark:border-gray-800 px-2', prefs.sidebar.open ? 'justify-end' : 'justify-center')}>
          <button
            onClick={() => update('sidebar', { open: !prefs.sidebar.open })}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            title={prefs.sidebar.open ? 'Collapse sidebar' : 'Expand sidebar'}
          >
            {prefs.sidebar.open ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
          </button>
        </div>

        <nav className="flex flex-col gap-1 p-2">
          {MODES.map(({ id, label, desc, icon }) => (
            <button
              key={id}
              onClick={() => setMode(id)}
              title={prefs.sidebar.open ? undefined : label}
              className={cn(
                'flex items-center gap-3 rounded px-2 py-2 text-left transition-colors',
                mode === id
                  ? 'bg-gray-900 text-white'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800',
              )}
            >
              <span className="shrink-0">{icon}</span>
              {prefs.sidebar.open && (
                <span className="min-w-0">
                  <span className="block text-xs font-medium">{label}</span>
                  <span className={cn('block text-[10px] leading-tight truncate', mode === id ? 'text-gray-300' : 'text-gray-400 dark:text-gray-600')}>{desc}</span>
                </span>
              )}
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex-1 flex flex-col p-2 sm:p-4 gap-1.5 sm:gap-2 overflow-hidden bg-muted/30 dark:bg-gray-950 min-h-0">
        {/* Settings page */}
        {mode === 'settings' && (
          <div className="flex-1 overflow-y-auto">
            <SettingsPanel
              selectedOpeningId={prefs.selectedOpeningId}
              onSelectOpening={setSelectedOpeningId}
            />
          </div>
        )}

        {/* Insights tab */}
        {mode === 'insights' && (
          <InsightsTab />
        )}

        {/* Board modes */}
        {isBoardMode && (
          <>
            {/* Top toolbar */}
            <div className="flex items-center gap-1.5 shrink-0">
              {mode === 'explorer' && (
                <button
                  onClick={() => update('explorer', { showHints: !prefs.explorer.showHints })}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-xs transition-colors',
                    prefs.explorer.showHints
                      ? 'bg-amber-50 text-amber-700 border-amber-300 hover:bg-amber-100 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800'
                      : 'bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200',
                  )}
                  title={prefs.explorer.showHints ? 'Hide move arrows' : 'Show move arrows'}
                >
                  <Lightbulb className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Hints</span>
                </button>
              )}
              {mode === 'explorer' && (
                <button
                  onClick={explorer.reset}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                  title="Reset to start"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Reset</span>
                </button>
              )}
              {mode === 'explorer' && (
                <button
                  onClick={() => update('explorer', { showTable: !prefs.explorer.showTable })}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-xs transition-colors',
                    prefs.explorer.showTable
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200',
                  )}
                  title={prefs.explorer.showTable ? 'Hide variations table' : 'Show variations table'}
                >
                  <Table2 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Variations</span>
                </button>
              )}
              {mode === 'explorer' && (
                <button
                  onClick={() => update('explorer', { showEval: !prefs.explorer.showEval })}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-xs transition-colors',
                    prefs.explorer.showEval
                      ? 'bg-blue-50 text-blue-700 border-blue-300 hover:bg-blue-100 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800'
                      : 'bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200',
                  )}
                  title={prefs.explorer.showEval ? 'Hide evaluation' : 'Show evaluation'}
                >
                  <BarChart2 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Eval</span>
                </button>
              )}
              {mode === 'explorer' && explorer.inFreeExplore && (
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-900/20 text-xs text-violet-600 dark:text-violet-400 select-none">
                  <Compass className="h-3.5 w-3.5" />
                  Free exploration
                </div>
              )}
              {mode === 'practice' && practice.phase !== 'setup' && (
                <button
                  onClick={practice.reset}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                  title="Reset to setup"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Reset</span>
                </button>
              )}
              <button
                onClick={() => {
                  const section = mode === 'explorer' ? 'explorer' : 'practice'
                  update(section, { flipped: !prefs[section].flipped })
                }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                title="Flip board"
              >
                <FlipVertical2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Flip</span>
              </button>
            </div>

            {/* Board + optional eval bar */}
            <BoardSizer>
              {size => (
                <div style={{ width: size }} className="flex flex-col">
                  {/* Board square */}
                  <div style={{ width: size, height: size, position: 'relative' }}>
                    {/* Eval bar — floats to the left of the board, doesn't affect sizing */}
                    {mode === 'explorer' && prefs.explorer.showEval && (
                      <div style={{ position: 'absolute', right: '100%', top: 0, paddingRight: 8 }}>
                        <EvalBar
                          evaluation={stockfish}
                          height={size}
                          flipped={prefs.explorer.flipped}
                        />
                      </div>
                    )}
                    {mode === 'practice' && practice.phase === 'naming' && (() => {
                      const orientation = prefs.practice.flipped
                        ? practice.playerColor === 'white' ? 'black' : 'white'
                        : practice.playerColor
                      return (
                        <div style={{ position: 'absolute', right: '100%', top: 0, paddingRight: 8 }}>
                          <EvalBar
                            evaluation={practiceEval}
                            height={size}
                            flipped={orientation === 'black'}
                          />
                        </div>
                      )
                    })()}
                    <ChessBoard
                      key={`${mode}-${openingEntry.id}`}
                      config={mode === 'explorer' ? explorer.cgConfig : practice.cgConfig}
                      onMove={mode === 'explorer' ? explorer.handleMove : practice.handleMove}
                      onReady={mode === 'explorer' ? explorer.setCgApi : practice.setCgApi}
                    />
                    {mode === 'practice' && practice.phase === 'setup' && (
                      <div className="absolute inset-0 flex items-center justify-center gap-3 z-10 px-3">
                        <button
                          onClick={() => practice.startPractice('white')}
                          className="flex-1 flex flex-col items-center justify-center gap-3 py-10 rounded-xl bg-white/90 backdrop-blur text-gray-900 font-medium hover:bg-white border border-gray-200 transition-colors"
                        >
                          <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0NSIgaGVpZ2h0PSI0NSI+PGcgZmlsbD0ibm9uZSIgZmlsbC1ydWxlPSJldmVub2RkIiBzdHJva2U9IiMwMDAiIHN0cm9rZS13aWR0aD0iMS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0yMi41IDExLjYzVjZNMjAgOGg1IiBzdHJva2UtbGluZWpvaW49Im1pdGVyIi8+PHBhdGggZD0iTTIyLjUgMjVzNC41LTcuNSAzLTEwLjVjMCAwLTEtMi41LTMtMi41cy0zIDIuNS0zIDIuNWMtMS41IDMgMyAxMC41IDMgMTAuNSIgZmlsbD0iI2ZmZiIgc3Ryb2tlLWxpbmVjYXA9ImJ1dHQiIHN0cm9rZS1saW5lam9pbj0ibWl0ZXIiLz48cGF0aCBkPSJNMTEuNSAzN2M1LjUgMy41IDE1LjUgMy41IDIxIDB2LTdzOS00LjUgNi0xMC41Yy00LTYuNS0xMy41LTMuNS0xNiA0VjI3di0zLjVjLTMuNS03LjUtMTMtMTAuNS0xNi00LTMgNiA1IDEwIDUgMTBWMzd6IiBmaWxsPSIjZmZmIi8+PHBhdGggZD0iTTExLjUgMzBjNS41LTMgMTUuNS0zIDIxIDBtLTIxIDMuNWM1LjUtMyAxNS41LTMgMjEgMG0tMjEgMy41YzUuNS0zIDE1LjUtMyAyMSAwIi8+PC9nPjwvc3ZnPg==" alt="white king" width={72} height={72} />
                          <span className="text-base text-amber-600 dark:text-blue-300">Play as White</span>
                        </button>
                        <button
                          onClick={() => practice.startPractice('black')}
                          className="flex-1 flex flex-col items-center justify-center gap-3 py-10 rounded-xl bg-gray-900/90 backdrop-blur text-white font-medium hover:bg-gray-900 transition-colors"
                        >
                          <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0NSIgaGVpZ2h0PSI0NSI+PGcgZmlsbD0ibm9uZSIgZmlsbC1ydWxlPSJldmVub2RkIiBzdHJva2U9IiMwMDAiIHN0cm9rZS13aWR0aD0iMS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0yMi41IDExLjYzVjYiIHN0cm9rZS1saW5lam9pbj0ibWl0ZXIiLz48cGF0aCBkPSJNMjIuNSAyNXM0LjUtNy41IDMtMTAuNWMwIDAtMS0yLjUtMy0yLjVzLTMgMi41LTMgMi41Yy0xLjUgMyAzIDEwLjUgMyAxMC41IiBmaWxsPSIjMDAwIiBzdHJva2UtbGluZWNhcD0iYnV0dCIgc3Ryb2tlLWxpbmVqb2luPSJtaXRlciIvPjxwYXRoIGQ9Ik0xMS41IDM3YzUuNSAzLjUgMTUuNSAzLjUgMjEgMHYtN3M5LTQuNSA2LTEwLjVjLTQtNi41LTEzLjUtMy41LTE2IDRWMjd2LTMuNWMtMy41LTcuNS0xMy0xMC41LTE2LTQtMyA2IDUgMTAgNSAxMFYzN3oiIGZpbGw9IiMwMDAiLz48cGF0aCBkPSJNMjAgOGg1IiBzdHJva2UtbGluZWpvaW49Im1pdGVyIi8+PHBhdGggZD0iTTMyIDI5LjVzOC41LTQgNi4wMy05LjY1QzM0LjE1IDE0IDI1IDE4IDIyLjUgMjQuNWwuMDEgMi4xLS4wMS0yLjFDMjAgMTggOS45MDYgMTQgNi45OTcgMTkuODVjLTIuNDk3IDUuNjUgNC44NTMgOSA0Ljg1MyA5IiBzdHJva2U9IiNlY2VjZWMiLz48cGF0aCBkPSJNMTEuNSAzMGM1LjUtMyAxNS41LTMgMjEgMG0tMjEgMy41YzUuNS0zIDE1LjUtMyAyMSAwbS0yMSAzLjVjNS41LTMgMTUuNS0zIDIxIDAiIHN0cm9rZT0iI2VjZWNlYyIvPjwvZz48L3N2Zz4=" alt="black king" width={72} height={72} />
                          <span className="text-base text-amber-600 dark:text-blue-300">Play as Black</span>
                        </button>
                      </div>
                    )}
                    {mode === 'practice' && practice.phase === 'freeplay' && practice.freeplayBotTurn && (
                      <div className="absolute inset-0 z-10 pointer-events-none" style={{ cursor: 'wait' }}>
                        <div className="absolute inset-0 bg-black/10 rounded-sm" />
                        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-gray-900/85 backdrop-blur-sm text-white text-xs font-medium px-3 py-1.5 rounded-full shadow-lg select-none">
                          <svg className="animate-spin h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          Computing…
                        </div>
                      </div>
                    )}
                    {mode === 'practice' && practice.phase === 'naming' && (
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none"
                        style={{ background: 'rgba(20,120,60,0.13)' }}>
                        <div className="bg-white rounded-full p-3 shadow-lg">
                          <CheckCircle2 className="h-10 w-10 text-green-500" />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Status bar — directly below board square, never overlaps pieces */}
                  {mode === 'practice' && (practice.phase === 'playing' || practice.phase === 'freeplay') && (
                    <div className={cn(
                      'flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-b-md mt-px',
                      practice.lastResult === 'wrong'    ? 'bg-red-100 text-red-800' :
                      practice.lastResult === 'blunder'  ? 'bg-red-100 text-red-800' :
                      practice.lastResult === 'mistake'  ? 'bg-orange-100 text-orange-800' :
                      practice.lastResult === 'correct'  ? 'bg-green-100 text-green-800' :
                      practice.phase === 'freeplay'      ? 'bg-violet-50 text-violet-700' :
                                                           'bg-gray-100 text-gray-700',
                    )}>
                      {practice.phase === 'freeplay' && practice.lastResult !== 'blunder' && practice.lastResult !== 'mistake' && (
                        <span className="opacity-50 shrink-0">⚡</span>
                      )}
                      <span className="flex-1">
                        {practice.lastResult === 'wrong'   ? 'Not in the book — try another move' :
                         practice.lastResult === 'blunder'  ? `Blunder! −${(practice.lastErrorDrop! / 100).toFixed(1)} pawns — try again` :
                         practice.lastResult === 'mistake'  ? `Mistake! −${(practice.lastErrorDrop! / 100).toFixed(1)} pawns — try again` :
                         practice.lastResult === 'correct'  ? 'Correct!' :
                         practice.freeplayBotTurn           ? 'Stockfish thinking…' :
                         practice.isPlayerTurn              ? `Your turn (${practice.playerColor})` :
                                                              'Computer thinking…'}
                      </span>
                      {practice.phase === 'playing' && (
                        <span className="shrink-0 opacity-60">Score: {practice.score}</span>
                      )}
                      {practice.phase === 'freeplay' && practice.inaccuracies.length > 0 && (
                        <span className="shrink-0 opacity-60">
                          {practice.inaccuracies.length} error{practice.inaccuracies.length !== 1 ? 's' : ''}
                        </span>
                      )}
                      {practice.phase === 'playing' && (
                        <button
                          onClick={practice.showHint}
                          disabled={!practice.isPlayerTurn && practice.lastResult !== 'wrong'}
                          className="p-1 rounded hover:bg-black/10 disabled:opacity-30 transition-colors shrink-0"
                          title="Show hint"
                        >
                          <Lightbulb className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </BoardSizer>

            {/* Move history — explorer */}
            {mode === 'explorer' && (
              <MoveHistory path={explorer.path} freePath={explorer.freePath} onGoTo={explorer.goToIndex} />
            )}

            {/* Move history — practice (playing / freeplay / naming phases) */}
            {mode === 'practice' && (practice.phase === 'playing' || practice.phase === 'freeplay' || practice.phase === 'naming') && (
              <MoveHistory
                path={practice.path}
                freePath={practice.freeplayMoves}
                currentIdx={
                  practice.viewIndex !== null
                    ? practice.viewIndex + 1
                    : practice.path.length - 1 + practice.freeplayMoves.length
                }
                onGoTo={idx => {
                  const liveIdx = practice.path.length - 1 + practice.freeplayMoves.length
                  practice.goToMove(idx === liveIdx ? null : idx - 1)
                }}
              />
            )}

            {/* Variation table — explorer only, toggleable */}
            {mode === 'explorer' && prefs.explorer.showTable && (
              <VariationTable
                variations={explorer.matchingVariations}
                selected={explorer.selectedVariation}
                depth={explorer.depth}
                onSelect={explorer.setSelectedVariation}
              />
            )}

            {/* Practice controls — practice mode only */}
            {mode === 'practice' && (
              <PracticePanel
                phase={practice.phase}
                score={practice.score}
                naming={practice.naming}
                selectedChoice={practice.selectedChoice}
                onSelectChoice={practice.selectChoice}
                onProceed={practice.proceed}
              />
            )}
          </>
        )}
      </main>
      </div>
      {/* Mobile bottom nav */}
      <nav className="sm:hidden shrink-0 flex border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        {MODES.map(({ id, label, icon }) => (
          <button
            key={id}
            onClick={() => setMode(id)}
            className={cn(
              'flex-1 flex flex-col items-center justify-center py-2 gap-0.5 text-[10px] font-medium transition-colors',
              mode === id ? 'text-gray-900 dark:text-white' : 'text-gray-400 dark:text-gray-500',
            )}
          >
            {icon}
            {label}
          </button>
        ))}
      </nav>
      </div>
    </div>
  )
}

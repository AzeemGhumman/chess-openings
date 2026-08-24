import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStockfish } from '@/hooks/useStockfish'
import { Chess } from 'chess.js'
import type { Config } from '@lichess-org/chessground/config'
import type { Key } from '@lichess-org/chessground/types'
import {
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ChessBoard } from '@/components/ChessBoard'
import {
  loadSession, saveSession, clearSession, broadcastSession, getTokenExpiry,
} from '@/lib/session'
import type { StoredSession, GoogleUser } from '@/lib/session'

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase =
  | { tag: 'idle' }
  | { tag: 'loading-profile'; user: GoogleUser; idToken: string }
  | { tag: 'authenticated';   user: GoogleUser; idToken: string }
  | { tag: 'saving';          user: GoogleUser; idToken: string; chesscomUsername: string }
  | { tag: 'connected';       user: GoogleUser; idToken: string; chesscomUsername: string }
  | { tag: 'error'; message: string }

interface FirstError {
  san: string; delta_cp: number; eval_after_cp: number
  move_number: number; error_type: string; ply: number; eval_before_cp: number
}

interface Game {
  game_timestamp: number; game_url: string; end_time_iso: string
  user_color: 'white' | 'black'; opponent_username: string; user_result: string
  first_error_type: 'none' | 'mistake' | 'blunder'; first_error?: FirstError
  pgn_compact: string; time_class?: string; user_rating?: number
}

interface GetUserGamesResponse {
  ok: boolean; username: string; count: number; games: Game[]; next_token: string | null
}

interface MeSummaryResponse {
  ok: boolean
  summary: {
    profile: {
      email: string; name?: string; chess_com_username?: string
      lichess_username?: string; updated_at?: string; last_analyze_requested_at?: string
    }
    analyzed_games_count: number
    latest_game: null | { game_timestamp: number; game_url?: string; end_time_iso?: string; first_error_type?: string }
  }
}

interface GamesState {
  status: 'loading' | 'loaded' | 'error'
  games: Game[]; nextToken: string | null; error: string | null; loadingMore: boolean
}

interface ParsedMove {
  san: string; uci: string; from: string; to: string; promotion?: string; fen: string
}

interface Stats {
  total: number; wins: number; draws: number; losses: number; winRate: number
  avgFirstErrorMove: number | null; blunderCount: number; mistakeCount: number; cleanCount: number
}

// ─── API ─────────────────────────────────────────────────────────────────────

const API_BASE = import.meta.env.DEV
  ? '/api'
  : 'https://wl5joz6sg0.execute-api.us-east-1.amazonaws.com/prod'

class AuthError extends Error {}
class NotFoundError extends Error {}

async function getWithAuth<T>(path: string, idToken: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 || res.status === 403) throw new AuthError('Session expired. Please sign in again.')
  if (res.status === 404) throw new NotFoundError((data as { error?: string })?.error ?? 'Not found')
  if (!res.ok) throw new Error((data as { error?: string })?.error ?? `HTTP ${res.status}`)
  return data as T
}

async function postWithAuth(path: string, idToken: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 || res.status === 403) throw new AuthError('Session expired. Please sign in again.')
  if (!res.ok) throw new Error((data as { error?: string })?.error ?? `HTTP ${res.status}`)
  return data
}

async function getMeSummary(idToken: string): Promise<MeSummaryResponse> {
  return getWithAuth<MeSummaryResponse>('/me/summary', idToken)
}

export async function updateUserProfile(idToken: string, name: string, chesscomUsername: string): Promise<void> {
  await postWithAuth('/user', idToken, { name, chess_com_username: chesscomUsername, lichess_username: '' })
}

async function queueAnalysis(idToken: string): Promise<void> {
  await postWithAuth('/analyze-user-games', idToken, {})
}

async function fetchUserGames(idToken: string, opts?: { limit?: number; nextToken?: string }): Promise<GetUserGamesResponse> {
  const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 50)
  const params = new URLSearchParams({ limit: String(limit) })
  if (opts?.nextToken) params.set('next_token', opts.nextToken)
  return getWithAuth<GetUserGamesResponse>(`/user-games?${params.toString()}`, idToken)
}

// ─── Google OAuth via Identity Services ──────────────────────────────────────

export const GOOGLE_CLIENT_ID = '253167513473-dn63puhmfaiqhcvo9b97odugt51s88u7.apps.googleusercontent.com'

declare global {
  interface Window {
    google?: {
      accounts: { id: {
        initialize:   (cfg: { client_id: string; callback: (r: { credential: string }) => void; auto_select?: boolean }) => void
        renderButton: (parent: HTMLElement, opts: Record<string, string>) => void
        cancel:       () => void
        prompt:       (cb?: (n: { isNotDisplayed: () => boolean; isSkippedMoment: () => boolean }) => void) => void
      }}
    }
  }
}

export function decodeGoogleCredential(credential: string): GoogleUser {
  const p = JSON.parse(atob(credential.split('.')[1]))
  return { id: p.sub, name: p.name, email: p.email, picture: p.picture }
}

// ─── Token auto-refresh ───────────────────────────────────────────────────────

// Promise-based silent GIS refresh — resolves with new credential or null if it can't
// be done without user interaction (e.g. user has signed out of Google entirely).
function attemptSilentRefresh(): Promise<string | null> {
  return new Promise(resolve => {
    const run = () => {
      if (!window.google?.accounts?.id) { setTimeout(run, 100); return }
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: ({ credential }: { credential: string }) => resolve(credential),
        auto_select: true,
      })
      window.google.accounts.id.prompt((notification: { isNotDisplayed(): boolean; isSkippedMoment(): boolean }) => {
        if (notification.isNotDisplayed() || notification.isSkippedMoment()) resolve(null)
      })
    }
    run()
  })
}

// Schedule a proactive silent refresh ~5 min before the token expires.
function scheduleSilentRefresh(
  idToken: string,
  onRefresh: (credential: string) => void,
): ReturnType<typeof setTimeout> | null {
  const expiry = getTokenExpiry(idToken)
  if (!expiry) return null
  const delay = expiry - Date.now() - 5 * 60 * 1000
  if (delay <= 0) return null  // Already expired — handled by on-mount refresh, not scheduler
  return setTimeout(() => {
    attemptSilentRefresh().then(credential => { if (credential) onRefresh(credential) })
  }, delay)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatResult(result: string): { label: string; color: string } {
  if (result === 'win') return { label: 'Won', color: 'text-emerald-600' }
  if (['checkmated', 'resigned', 'timeout', 'abandoned'].includes(result)) return { label: 'Lost', color: 'text-red-500' }
  return { label: 'Draw', color: 'text-gray-500' }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function parsePgn(pgn: string): { moves: ParsedMove[]; startFen: string } {
  const startFen = new Chess().fen()
  try {
    const chess = new Chess()
    chess.loadPgn(pgn)
    const history = chess.history({ verbose: true })
    const replay = new Chess()
    const moves: ParsedMove[] = history.map(m => {
      replay.move({ from: m.from, to: m.to, promotion: m.promotion })
      return { san: m.san, uci: m.from + m.to + (m.promotion ?? ''), from: m.from, to: m.to, promotion: m.promotion, fen: replay.fen() }
    })
    return { moves, startFen }
  } catch { return { moves: [], startFen } }
}

function computeStats(games: Game[]): Stats | null {
  if (!games.length) return null
  const total  = games.length
  const wins   = games.filter(g => g.user_result === 'win').length
  const losses = games.filter(g => ['checkmated', 'resigned', 'timeout', 'abandoned'].includes(g.user_result)).length
  const draws  = total - wins - losses
  const errorGames = games.filter(g => g.first_error_type !== 'none' && g.first_error)
  return {
    total, wins, draws, losses,
    winRate: Math.round((wins / total) * 100),
    avgFirstErrorMove: errorGames.length
      ? Math.round(errorGames.reduce((s, g) => s + g.first_error!.move_number, 0) / errorGames.length)
      : null,
    blunderCount: games.filter(g => g.first_error_type === 'blunder').length,
    mistakeCount: games.filter(g => g.first_error_type === 'mistake').length,
    cleanCount:   games.filter(g => g.first_error_type === 'none').length,
  }
}


// ─── Auth sub-components ──────────────────────────────────────────────────────


function ChesscomForm({ user, onSubmit, loading, error }: {
  user: GoogleUser; onSubmit: (u: string) => void; loading: boolean; error: string | null
}) {
  const [value, setValue] = useState('')
  return (
    <div className="w-full max-w-sm flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Connect your chess.com account</h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Enter your chess.com username to fetch and analyze your games.</p>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">Signed in as {user.email}</p>
      </div>
      <form onSubmit={e => { e.preventDefault(); const v = value.trim(); if (v) onSubmit(v) }} className="flex flex-col gap-3">
        <div className="flex gap-2">
          <input
            type="text" value={value} onChange={e => setValue(e.target.value)}
            placeholder="chess.com username" disabled={loading} autoFocus
            className="flex-1 px-3 py-2 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 text-xs focus:outline-none focus:border-gray-400 dark:focus:border-gray-500 disabled:opacity-50"
          />
          <button type="submit" disabled={loading || !value.trim()} className={cn(
            'flex items-center gap-1.5 px-4 py-2 rounded text-xs font-medium transition-all',
            loading || !value.trim() ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 cursor-not-allowed' : 'bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:bg-gray-700 dark:hover:bg-gray-100',
          )}>
            {loading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Saving…</> : 'Connect'}
          </button>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </form>
    </div>
  )
}

// ─── Connected-view sub-components ───────────────────────────────────────────

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins   = Math.floor(diffMs / 60_000)
  const hours  = Math.floor(diffMs / 3_600_000)
  const days   = Math.floor(diffMs / 86_400_000)
  if (mins < 1)   return 'just now'
  if (mins < 60)  return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days === 1) return 'yesterday'
  return `${days}d ago`
}

function GameListItem({ game, isSelected, onClick }: { game: Game; isSelected: boolean; onClick: () => void }) {
  const { label, color } = formatResult(game.user_result)
  return (
    <button onClick={onClick} className={cn(
      'w-full text-left flex flex-col gap-0.5 px-2.5 py-2 border-b border-gray-100 dark:border-gray-800 last:border-0 transition-colors',
      isSelected ? 'bg-gray-900 rounded-lg border-transparent' : 'hover:bg-gray-50 dark:hover:bg-gray-800',
    )}>
      <span className={cn('text-xs font-semibold', isSelected ? 'text-white' : color)}>{label}</span>
      <span className={cn('text-[10px] truncate', isSelected ? 'text-gray-300' : 'text-gray-500 dark:text-gray-400')}>vs {game.opponent_username}</span>
      <span className={cn('text-[9px]', isSelected ? 'text-gray-500' : 'text-gray-400 dark:text-gray-500')}>{formatDate(game.end_time_iso)}</span>
    </button>
  )
}

function ReplayMoveList({ moves, currentIndex, firstErrorIndex, firstErrorType, onGoTo }: {
  moves: ParsedMove[]; currentIndex: number; firstErrorIndex: number | null
  firstErrorType?: 'mistake' | 'blunder' | 'none'; onGoTo: (i: number) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [currentIndex])

  const pairs: Array<[ParsedMove, ParsedMove | null, number]> = []
  for (let i = 0; i < moves.length; i += 2) pairs.push([moves[i], moves[i + 1] ?? null, i])

  return (
    <div ref={listRef} className="flex flex-col gap-0.5 pr-1">
      {pairs.map(([white, black, base]) => (
        <div key={base} className="flex items-center gap-1 text-xs">
          <span className="w-7 shrink-0 text-gray-400 dark:text-gray-600 text-right text-[10px]">{base / 2 + 1}.</span>
          {([white, black] as (ParsedMove | null)[]).map((move, offset) => {
            if (!move) return <span key={offset} className="w-20" />
            const idx = base + offset
            const isActive = currentIndex === idx
            const isError  = firstErrorIndex === idx
            return (
              <button key={offset} data-active={isActive} onClick={() => onGoTo(idx)}
                className={cn(
                  'w-20 text-left px-1.5 py-0.5 rounded transition-colors text-xs font-medium',
                  isActive
                    ? 'bg-gray-800 text-white'
                    : isError
                      ? firstErrorType === 'blunder'
                        ? 'bg-red-100 text-red-700 ring-1 ring-red-300 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-400 dark:ring-red-700'
                        : 'bg-amber-100 text-amber-700 ring-1 ring-amber-300 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-400 dark:ring-amber-700'
                      : 'text-gray-700 dark:text-gray-300 font-normal hover:bg-gray-100 dark:hover:bg-gray-800',
                )}>
                {move.san}
                {isError && (
                  <sup className="ml-0.5 text-[9px] font-bold">
                    {firstErrorType === 'blunder' ? '??' : '?'}
                  </sup>
                )}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function EvalBar({ evalCp }: { evalCp: number | null }) {
  const whitePercent = evalCp === null
    ? 50
    : Math.min(100, Math.max(0, 50 + 50 * Math.tanh(evalCp / 600)))

  const blackPercent = 100 - whitePercent
  const evalText = evalCp === null ? null
    : evalCp > 0  ? `+${(evalCp / 100).toFixed(1)}`
    : evalCp < 0  ? `−${(Math.abs(evalCp) / 100).toFixed(1)}`
    : '='
  const labelInBlack = blackPercent >= 28

  return (
    <div className="relative w-full h-full flex flex-col overflow-hidden rounded-sm select-none">
      <div
        className="bg-[#1f1f1f] transition-all duration-500 ease-in-out flex items-center justify-center"
        style={{ height: `${blackPercent}%` }}
      >
        {labelInBlack && evalText && (
          <span className="text-[7px] font-bold text-gray-400 tabular-nums">{evalText}</span>
        )}
      </div>
      <div className="flex-1 bg-[#f0ede8] transition-all duration-500 ease-in-out flex items-center justify-center">
        {!labelInBlack && evalText && (
          <span className="text-[7px] font-bold text-gray-500 tabular-nums">{evalText}</span>
        )}
      </div>
    </div>
  )
}

function GameReplay({ game }: { game: Game }) {
  const { moves, startFen } = useMemo(() => parsePgn(game.pgn_compact), [game.pgn_compact])
  const firstErrorIndex = game.first_error ? game.first_error.ply - 1 : null
  const [moveIndex, setMoveIndex] = useState<number>(() => firstErrorIndex ?? -1)

  useEffect(() => { setMoveIndex(firstErrorIndex ?? -1) }, [game.game_timestamp, firstErrorIndex])

  const currentFen = moveIndex === -1 ? startFen : (moves[moveIndex]?.fen ?? startFen)
  const lastMove   = moveIndex >= 0 && moves[moveIndex]
    ? [moves[moveIndex].from, moves[moveIndex].to] as [Key, Key] : undefined
  const isAtError  = firstErrorIndex !== null && moveIndex === firstErrorIndex
  const errorMove  = firstErrorIndex !== null ? moves[firstErrorIndex] : null

  const boardConfig = useMemo((): Config => ({
    fen: currentFen,
    orientation: game.user_color,
    lastMove,
    viewOnly: true,
    drawable: {
      enabled: false,
      autoShapes: isAtError && errorMove
        ? [{ orig: errorMove.from as Key, dest: errorMove.to as Key, brush: 'red' }]
        : [],
    },
  }), [currentFen, game.user_color, lastMove, isAtError, errorMove])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft')  setMoveIndex(i => Math.max(-1, i - 1))
      if (e.key === 'ArrowRight') setMoveIndex(i => Math.min(moves.length - 1, i + 1))
      if (e.key === 'ArrowUp')    { e.preventDefault(); setMoveIndex(-1) }
      if (e.key === 'ArrowDown')  { e.preventDefault(); setMoveIndex(moves.length - 1) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [moves.length])

  const sfEval = useStockfish(currentFen, true)
  const currentEvalCp = sfEval.mate !== null
    ? (sfEval.mate > 0 ? 10000 : -10000)
    : sfEval.score

  // Measure board area to fill available space
  const boardAreaRef = useRef<HTMLDivElement>(null)
  const [boardSize, setBoardSize] = useState(360)
  useEffect(() => {
    const el = boardAreaRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      // On mobile (stacked layout) height is auto/0 — fall back to width
      const effectiveHeight = height > 50 ? height : width - 20
      setBoardSize(Math.floor(Math.min(width - 20, effectiveHeight, 480)))
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const { label: resultLabel, color: resultColor } = formatResult(game.user_result)

  return (
    <div className="flex flex-col gap-2 p-2 sm:p-4 overflow-y-auto md:overflow-hidden md:h-full">
      {/* ── Game header ── */}
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        <span className={cn('text-sm font-bold', resultColor)}>{resultLabel}</span>
        <span className="text-xs text-gray-400 dark:text-gray-500">as {game.user_color}</span>
        <span className="text-gray-200 dark:text-gray-700">·</span>
        <span className="text-xs text-gray-600 dark:text-gray-400 font-medium">vs {game.opponent_username}</span>
        <span className="text-gray-200 dark:text-gray-700">·</span>
        <span className="text-xs text-gray-400 dark:text-gray-500">{formatDate(game.end_time_iso)}</span>
      </div>

      {/* ── Board + moves: stacked on mobile, side-by-side on md+ ── */}
      <div className="flex flex-col md:flex-row md:flex-1 gap-3 md:gap-4 md:min-h-0">
        {/* Board column */}
        <div className="flex flex-col gap-2 min-w-0 md:flex-1 md:min-h-0">
          {/* Sized board area */}
          <div ref={boardAreaRef} className="flex items-start md:flex-1 md:min-h-0">
            <div className="flex gap-1.5" style={{ width: boardSize + 20, height: boardSize }}>
              <div className="w-3.5 shrink-0 self-stretch">
                <EvalBar evalCp={currentEvalCp} />
              </div>
              <div style={{ width: boardSize, height: boardSize }}>
                <ChessBoard config={boardConfig} />
              </div>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-0.5 shrink-0">
            {([
              [ChevronsLeft,  'First',    () => setMoveIndex(-1)],
              [ChevronLeft,   'Previous', () => setMoveIndex(i => Math.max(-1, i - 1))],
              [ChevronRight,  'Next',     () => setMoveIndex(i => Math.min(moves.length - 1, i + 1))],
              [ChevronsRight, 'Last',     () => setMoveIndex(moves.length - 1)],
            ] as const).map(([Icon, label, action]) => (
              <button key={label} onClick={action} title={label}
                className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors">
                <Icon className="h-4 w-4" />
              </button>
            ))}
            {firstErrorIndex !== null && (
              <button onClick={() => setMoveIndex(firstErrorIndex)}
                className={cn(
                  'ml-1.5 px-2 py-1 rounded text-[10px] font-bold transition-colors',
                  isAtError ? 'bg-red-500 text-white' : 'bg-red-50 text-red-500 hover:bg-red-100',
                )}>
                {game.first_error_type === 'blunder' ? '??' : '?'} Jump
              </button>
            )}
            <p className="ml-auto text-[9px] text-gray-300 dark:text-gray-600 hidden sm:block">← → keys</p>
          </div>
        </div>

        {/* ── Right panel: error card + move list ── */}
        <div className="md:w-56 shrink-0 flex flex-col gap-3 md:overflow-y-auto">
          {game.first_error && firstErrorIndex !== null && (
            <button
              onClick={() => setMoveIndex(firstErrorIndex)}
              className={cn(
                'flex flex-col gap-1 p-2.5 rounded-lg border transition-all text-xs shrink-0 text-left w-full',
                isAtError
                  ? 'border-red-200 bg-red-50 hover:bg-red-100 dark:border-red-800 dark:bg-red-900/20 dark:hover:bg-red-900/30'
                  : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700',
              )}
            >
              <div className="flex items-center justify-between gap-4">
                <span className={cn('font-semibold', isAtError ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-300')}>
                  {game.first_error_type === 'blunder' ? '?? Blunder' : '? Mistake'}: {game.first_error.san}
                </span>
                <span className="text-gray-400 shrink-0">Move {game.first_error.move_number}</span>
              </div>
              <div className="flex gap-3 text-[10px] text-gray-400 dark:text-gray-500">
                <span>Before <span className="font-mono">{(game.first_error.eval_before_cp / 100).toFixed(2)}</span></span>
                <span>After <span className="font-mono">{(game.first_error.eval_after_cp / 100).toFixed(2)}</span></span>
                <span className="text-red-400 font-medium">−{(Math.abs(game.first_error.delta_cp) / 100).toFixed(2)} pawns</span>
              </div>
            </button>
          )}

          <div className="flex flex-col gap-1">
            <span className="text-[9px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide shrink-0">Moves</span>
            <ReplayMoveList
              moves={moves} currentIndex={moveIndex} firstErrorIndex={firstErrorIndex}
              firstErrorType={game.first_error_type !== 'none' ? game.first_error_type : undefined}
              onGoTo={setMoveIndex}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Main connected view ──────────────────────────────────────────────────────

function ConnectedView({ gamesState, stats, selectedGame, lastAnalyzedAt, onLoadMore, onSelectGame }: {
  gamesState: GamesState; stats: Stats | null; selectedGame: Game | null
  lastAnalyzedAt: string | null
  onLoadMore: () => void
  onSelectGame: (g: Game) => void
}) {

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header: chess.com badge + stats */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between px-3 sm:px-4 py-2 border-b border-gray-100 dark:border-gray-800 shrink-0 gap-2">
        <div className="flex items-center gap-3 min-w-0">
          {lastAnalyzedAt && (
            <span className="text-[10px] text-gray-400 dark:text-gray-500 shrink-0">
              Updated <span className="font-medium text-gray-500 dark:text-gray-400">{relativeTime(lastAnalyzedAt)}</span>
            </span>
          )}
        </div>
        {stats && (
          <div className="flex items-stretch divide-x divide-gray-100 dark:divide-gray-800 shrink-0">
            <div className="flex flex-col items-center px-2 sm:px-3 gap-0.5">
              <span className="text-sm font-bold text-emerald-600 leading-none">{stats.winRate}%</span>
              <span className="text-[9px] text-gray-400 dark:text-gray-500 whitespace-nowrap">{stats.wins}W {stats.draws}D {stats.losses}L</span>
            </div>
            {stats.avgFirstErrorMove !== null && (
              <div className="flex flex-col items-center px-2 sm:px-3 gap-0.5">
                <span className="text-sm font-bold text-amber-600 leading-none">Move {stats.avgFirstErrorMove}</span>
                <span className="text-[9px] text-gray-400 dark:text-gray-500">Avg error</span>
              </div>
            )}
            <div className="flex flex-col items-center px-2 sm:px-3 gap-0.5">
              <span className="text-sm font-bold text-gray-700 dark:text-gray-200 leading-none">{stats.cleanCount}/{stats.total}</span>
              <span className="text-[9px] text-gray-400 dark:text-gray-500">Error-free</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col sm:flex-row flex-1 min-h-0">
        {/* Game list — horizontal scroll strip on mobile, vertical sidebar on sm+ */}
        <div className="shrink-0 border-b sm:border-b-0 sm:border-r border-gray-100 dark:border-gray-800 sm:w-44 sm:flex-col flex flex-row sm:flex sm:min-h-0 overflow-x-auto sm:overflow-x-hidden sm:overflow-y-auto">
          <div className="flex flex-row sm:flex-col gap-0.5 px-1.5 py-1.5 sm:py-0 sm:px-1.5 sm:pt-1 sm:flex-1 min-w-max sm:min-w-0">
            <div className="px-1.5 py-1 shrink-0 self-center sm:px-1.5 sm:pb-1">
              <span className="text-[9px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide whitespace-nowrap">
                Games {gamesState.games.length > 0 && `(${gamesState.games.length})`}
              </span>
            </div>
            {gamesState.status === 'loading' && (
              <div className="flex items-center gap-2 text-[10px] text-gray-400 p-2">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading…
              </div>
            )}
            {gamesState.status === 'error' && <p className="text-[10px] text-red-400 p-2">{gamesState.error}</p>}
            {gamesState.games.map(game => (
              <GameListItem
                key={game.game_timestamp} game={game}
                isSelected={selectedGame?.game_timestamp === game.game_timestamp}
                onClick={() => onSelectGame(game)}
              />
            ))}
            {gamesState.nextToken && (
              <button onClick={onLoadMore} disabled={gamesState.loadingMore}
                className="shrink-0 self-center sm:self-auto text-[10px] text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 px-3 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors flex items-center gap-1 whitespace-nowrap">
                {gamesState.loadingMore ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Loading…</> : 'Load more'}
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          {selectedGame
            ? <GameReplay key={selectedGame.game_timestamp} game={selectedGame} />
            : <div className="flex items-center justify-center h-full text-xs text-gray-300 dark:text-gray-600">Select a game to replay</div>
          }
        </div>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function InsightsTab() {
  const [phase, setPhase] = useState<Phase>(() => {
    const s = loadSession()
    if (!s) return { tag: 'idle' }
    if (s.chesscomUsername)
      return { tag: 'connected', user: s.user, idToken: s.idToken, chesscomUsername: s.chesscomUsername }
    // Session exists but no username cached — check server before showing the form
    return { tag: 'loading-profile', user: s.user, idToken: s.idToken }
  })
  const [formError, setFormError]         = useState<string | null>(null)
  const [selectedGame, setSelectedGame]   = useState<Game | null>(null)
  const [refetchKey]                      = useState(0)
  const [lastAnalyzedAt, setLastAnalyzedAt] = useState<string | null>(null)
  const [gamesState, setGamesState]     = useState<GamesState>({
    status: 'loading', games: [], nextToken: null, error: null, loadingMore: false,
  })

  const stats = useMemo(() => computeStats(gamesState.games), [gamesState.games])

  // Broadcast session whenever phase settles to a stable state
  useEffect(() => {
    if (phase.tag === 'connected') {
      const s: StoredSession = { user: phase.user, idToken: phase.idToken, chesscomUsername: phase.chesscomUsername }
      broadcastSession(s)
    } else if (phase.tag === 'authenticated') {
      broadcastSession({ user: phase.user, idToken: phase.idToken })
    } else if (phase.tag === 'idle') {
      broadcastSession(null)
    }
  }, [phase])

  const handleSignOut = useCallback(() => {
    clearSession()
    broadcastSession(null)
    setPhase({ tag: 'idle' })
    setSelectedGame(null)
  }, [])

  // Listen for sign-out requests from the global header
  useEffect(() => {
    const handler = () => handleSignOut()
    window.addEventListener('chess-signout-request', handler)
    return () => window.removeEventListener('chess-signout-request', handler)
  }, [handleSignOut])

  // Listen for sign-in from the global header — transition from idle to loading-profile
  useEffect(() => {
    const handler = (e: Event) => {
      const s = (e as CustomEvent<StoredSession | null>).detail
      if (!s) return
      setPhase(p => p.tag === 'idle' ? { tag: 'loading-profile', user: s.user, idToken: s.idToken } : p)
    }
    window.addEventListener('chess-session', handler)
    return () => window.removeEventListener('chess-session', handler)
  }, [])

  // Token auto-refresh: schedule silent re-auth before token expires
  useEffect(() => {
    const idToken = phase.tag === 'connected' || phase.tag === 'authenticated' ? phase.idToken : null
    if (!idToken) return
    const timer = scheduleSilentRefresh(idToken, credential => {
      try {
        const user = decodeGoogleCredential(credential)
        const currentPhase = phase
        if (currentPhase.tag === 'connected') {
          const s: StoredSession = { user, idToken: credential, chesscomUsername: currentPhase.chesscomUsername }
          saveSession(s)
          broadcastSession(s)
          setPhase({ ...currentPhase, user, idToken: credential })
        } else if (currentPhase.tag === 'authenticated') {
          const s: StoredSession = { user, idToken: credential }
          saveSession(s)
          broadcastSession(s)
          setPhase({ ...currentPhase, user, idToken: credential })
        }
      } catch { /* ignore decode errors */ }
    })
    return () => { if (timer !== null) clearTimeout(timer) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.tag])

  // On mount: silently sync profile from backend (runs every tab navigation)
  useEffect(() => {
    let cancelled = false
    async function init() {
      const session = loadSession()
      if (!session) return
      let { user, idToken } = session

      // If the stored token is expired, attempt a silent GIS refresh before hitting the backend.
      // This covers the "page reload with expired token" case transparently.
      const expiry = getTokenExpiry(idToken)
      if (expiry && expiry < Date.now()) {
        const newCredential = await attemptSilentRefresh()
        if (cancelled) return
        if (newCredential) {
          try { user = decodeGoogleCredential(newCredential) } catch { /* keep old user */ }
          idToken = newCredential
        }
        // If refresh failed (null), we'll still try the backend — it'll 403 if truly invalid,
        // but often the token is still accepted for a short grace period after exp.
      }

      try {
        const res = await getMeSummary(idToken)
        if (cancelled) return
        const chesscomUsername = res.summary.profile.chess_com_username
        if (res.summary.profile.last_analyze_requested_at) setLastAnalyzedAt(res.summary.profile.last_analyze_requested_at)
        if (chesscomUsername) {
          saveSession({ user, idToken, chesscomUsername })
          setPhase(p =>
            p.tag === 'connected' && p.chesscomUsername === chesscomUsername
              ? p
              : { tag: 'connected', user, idToken, chesscomUsername },
          )
        } else {
          saveSession({ user, idToken })
          setPhase(p => p.tag === 'authenticated' ? p : { tag: 'authenticated', user, idToken })
        }
      } catch (err) {
        if (cancelled) return
        if (err instanceof AuthError) {
          // Token truly invalid and silent refresh failed — must sign in again
          clearSession(); broadcastSession(null); setPhase({ tag: 'idle' }); return
        }
        if (err instanceof NotFoundError) {
          saveSession({ user, idToken })
          setPhase(p => p.tag === 'authenticated' ? p : { tag: 'authenticated', user, idToken })
        }
      }
    }
    init()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // After Google sign-in, load profile from backend
  useEffect(() => {
    if (phase.tag !== 'loading-profile') return
    const { user, idToken } = phase
    let cancelled = false

    getMeSummary(idToken)
      .then(res => {
        if (cancelled) return
        const chesscomUsername = res.summary.profile.chess_com_username
        if (res.summary.profile.last_analyze_requested_at) setLastAnalyzedAt(res.summary.profile.last_analyze_requested_at)
        if (chesscomUsername) {
          saveSession({ user, idToken, chesscomUsername })
          setPhase({ tag: 'connected', user, idToken, chesscomUsername })
        } else {
          saveSession({ user, idToken })
          setPhase({ tag: 'authenticated', user, idToken })
        }
      })
      .catch(err => {
        if (cancelled) return
        if (err instanceof AuthError) { clearSession(); setPhase({ tag: 'idle' }); return }
        if (err instanceof NotFoundError) {
          saveSession({ user, idToken })
          setPhase({ tag: 'authenticated', user, idToken })
          return
        }
        setPhase({ tag: 'error', message: (err as Error).message })
      })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.tag])

  // Fetch games when connected
  useEffect(() => {
    if (phase.tag !== 'connected') return
    const { idToken } = phase
    let cancelled = false

    setGamesState({ status: 'loading', games: [], nextToken: null, error: null, loadingMore: false })
    setSelectedGame(null)

    fetchUserGames(idToken, { limit: 10 })
      .then(res => {
        if (cancelled) return
        setGamesState({ status: 'loaded', games: res.games, nextToken: res.next_token, error: null, loadingMore: false })
        if (res.games.length > 0) setSelectedGame(res.games[0])
      })
      .catch(err => {
        if (cancelled) return
        if (err instanceof AuthError) { handleSignOut(); return }
        setGamesState({ status: 'error', games: [], nextToken: null, error: (err as Error).message, loadingMore: false })
      })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.tag, refetchKey])

  const handleLoadMore = useCallback(() => {
    if (phase.tag !== 'connected' || !gamesState.nextToken) return
    const { idToken } = phase
    setGamesState(s => ({ ...s, loadingMore: true }))
    fetchUserGames(idToken, { limit: 10, nextToken: gamesState.nextToken ?? undefined })
      .then(res => setGamesState(s => ({ ...s, games: [...s.games, ...res.games], nextToken: res.next_token, loadingMore: false })))
      .catch(err => {
        if (err instanceof AuthError) { handleSignOut(); return }
        setGamesState(s => ({ ...s, loadingMore: false, error: (err as Error).message }))
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, gamesState.nextToken])

  const handleUsernameSubmit = async (chesscomUsername: string) => {
    if (phase.tag !== 'authenticated') return
    const { user, idToken } = phase
    setFormError(null)
    setPhase({ tag: 'saving', user, idToken, chesscomUsername })
    try {
      await updateUserProfile(idToken, user.name, chesscomUsername)
      await queueAnalysis(idToken)
      saveSession({ user, idToken, chesscomUsername })
      setPhase({ tag: 'connected', user, idToken, chesscomUsername })
    } catch (err) {
      if (err instanceof AuthError) { clearSession(); setPhase({ tag: 'error', message: (err as Error).message }) }
      else { setPhase({ tag: 'authenticated', user, idToken }); setFormError((err as Error).message) }
    }
  }

  if (phase.tag === 'connected') {
    return (
      <ConnectedView
        gamesState={gamesState} stats={stats} selectedGame={selectedGame}
        lastAnalyzedAt={lastAnalyzedAt}
        onLoadMore={handleLoadMore} onSelectGame={setSelectedGame}
      />
    )
  }

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="w-full max-w-sm flex flex-col gap-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-base font-semibold text-gray-800 dark:text-gray-200">Game Insights</h1>
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Connect your accounts to let our servers analyze your games and surface patterns in your play.
          </p>
        </div>

        {phase.tag === 'idle' && (
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Use the <span className="font-medium text-gray-600 dark:text-gray-300">Sign in</span> button in the top-right corner to get started.
          </p>
        )}

        {phase.tag === 'loading-profile' && (
          <div className="flex items-center gap-2.5 text-xs text-gray-400 dark:text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin text-gray-500 dark:text-gray-400" />
            Loading your profile…
          </div>
        )}

        {(phase.tag === 'authenticated' || phase.tag === 'saving') && (
          <ChesscomForm
            user={phase.user} onSubmit={handleUsernameSubmit}
            loading={phase.tag === 'saving'} error={formError}
          />
        )}

        {phase.tag === 'error' && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-red-500">{phase.message}</p>
            <button onClick={() => setPhase({ tag: 'idle' })}
              className="self-start text-xs text-gray-500 dark:text-gray-400 underline underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200">
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

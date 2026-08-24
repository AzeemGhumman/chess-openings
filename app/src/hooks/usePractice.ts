import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Api } from '@lichess-org/chessground/api'
import type { Config } from '@lichess-org/chessground/config'
import type { Key } from '@lichess-org/chessground/types'
import { Chess } from 'chess.js'
import { ancestorName, type MoveNode, type OpeningData } from '@/data/openings'
import {
  StockfishEngine,
  classifyMove,
  evalDropForPlayer,
  detectEngineConfig,
  type EngineResult,
  type EngineConfig,
} from '@/lib/stockfishEngine'

// ─── Constants ───────────────────────────────────────────────────────────────

/** Number of player moves allowed in freeplay before the session ends. */
export const POST_OPENING_PLAYER_MOVES = 10

// ─── Types ────────────────────────────────────────────────────────────────────

export type PlayerColor = 'white' | 'black'

/** Phases of a practice session:
 *  setup   → player chooses a side
 *  playing → following the opening tree
 *  freeplay→ post-opening; bot plays Stockfish best moves, player plays freely
 *  naming  → multiple-choice quiz: which variation was it?
 *  review  → show errors collected during the session
 */
export type PracticePhase = 'setup' | 'playing' | 'freeplay' | 'naming' | 'review'

export type MoveResult = 'correct' | 'wrong' | 'offbook' | 'blunder' | 'mistake' | 'idle'

export interface NamingState {
  choices: string[]
  correct: string
}

export interface Inaccuracy {
  classification: 'offbook' | 'inaccuracy' | 'mistake' | 'blunder'
  fenBefore: string
  bestMove: string
  bestMoveSan: string
  movePlayed: string
  moveSan: string
  evalDrop: number        // centipawn loss; 0 for offbook (no eval available)
  evalBeforeCp?: number   // player's perspective eval before the move
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalise a Stockfish result to a centipawn score for comparison. */
function evalToCp(result: EngineResult): number {
  if (result.mate !== null) return result.mate > 0 ? 10_000 : -10_000
  return result.score
}

function getDistractors(
  excludeName: string,
  allVariations: OpeningData['variations'],
  count: number,
): string[] {
  const pool = allVariations.map(v => v.name).filter(n => n !== excludeName)
  for (let i = pool.length - 1; i > pool.length - 1 - count && i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(pool.length - count)
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Convert a UCI move string to SAN given a FEN position. Returns UCI on failure. */
function uciToSan(fen: string, uci: string): string {
  if (uci.length < 4) return uci
  try {
    const chess = new Chess(fen)
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] ?? 'q',
    })
    return move?.san ?? uci
  } catch {
    return uci
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function usePractice(flipped: boolean, openingData: OpeningData, openingName: string, dark = false) {
  const { variations, moveTree } = openingData

  // ── Core state ──────────────────────────────────────────────────────────────
  const [phase, setPhase]               = useState<PracticePhase>('setup')
  const [playerColor, setPlayerColor]   = useState<PlayerColor>('black')
  const [path, setPath]                 = useState<MoveNode[]>([moveTree])
  const [lastResult, setLastResult]     = useState<MoveResult>('idle')
  const [score, setScore]               = useState(0)
  const [naming, setNaming]             = useState<NamingState | null>(null)
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null)

  // ── Freeplay state ──────────────────────────────────────────────────────────
  const [freeplayFen, setFreeplayFen]           = useState<string | null>(null)
  const [freeplayLastMove, setFreeplayLastMove] = useState<[Key, Key] | undefined>(undefined)
  const [freeplayBotTurn, setFreeplayBotTurn]   = useState(false)
  const [inaccuracies, setInaccuracies]         = useState<Inaccuracy[]>([])
  /** Centipawn drop of the most recent freeplay blunder/mistake — shown briefly in the status bar. */
  const [lastErrorDrop, setLastErrorDrop]       = useState<number | null>(null)
  /** Shapes to overlay on the board (e.g. blunder threat arrow). Kept in React
   *  state so they survive chessground's FEN-triggered shape clear. */
  const [boardShapes, setBoardShapes]           = useState<{ orig: Key; dest: Key; brush: string }[]>([])
  /** Freeplay move list for the move-history strip. Each entry is one half-move. */
  const [freeplayMoves, setFreeplayMoves]       = useState<{ san: string; fen: string }[]>([])
  /** Browse index: null = live position; 0..N = view a past position read-only. */
  const [viewIndex, setViewIndex]               = useState<number | null>(null)

  // ── Refs ────────────────────────────────────────────────────────────────────
  const cgApiRef            = useRef<Api | null>(null)
  const computerMoving      = useRef(false)

  // Freeplay refs (stable, safe to read in async callbacks)
  const freeplayChessRef    = useRef<Chess | null>(null)
  const engineRef           = useRef<StockfishEngine | null>(null)
  const engineConfigRef     = useRef<EngineConfig>(detectEngineConfig())
  const evalBeforeRef       = useRef<EngineResult | null>(null)
  const postOpeningPlayerCount = useRef(0)

  /** Incremented whenever a freeplay session is aborted/reset. Async ops check
   *  this to detect stale work and bail out early. */
  const generationRef       = useRef(0)

  /** Mirrors playerColor state for access inside async closures. */
  const playerColorRef      = useRef<PlayerColor>('black')

  /** Mirrors inaccuracies state for access inside async closures. */
  const inaccuraciesRef     = useRef<Inaccuracy[]>([])

  /** What phase to enter after the naming quiz completes. */
  const phaseAfterNaming    = useRef<'playing' | 'review'>('playing')

  /** Variation name locked in when freeplay begins. */
  const freeplayNameRef     = useRef('')

  // Keep playerColorRef in sync with state
  useEffect(() => { playerColorRef.current = playerColor }, [playerColor])

  // Destroy engine on component unmount
  useEffect(() => {
    return () => {
      generationRef.current++
      engineRef.current?.destroy()
      engineRef.current = null
    }
  }, [])

  // ── Full reset when the opening changes ─────────────────────────────────────
  useEffect(() => {
    generationRef.current++
    engineRef.current?.destroy()
    engineRef.current = null
    freeplayChessRef.current = null
    inaccuraciesRef.current = []

    setPath([moveTree])
    setPhase('setup')
    setLastResult('idle')
    setNaming(null)
    setSelectedChoice(null)
    setScore(0)
    setFreeplayFen(null)
    setFreeplayLastMove(undefined)
    setFreeplayBotTurn(false)
    setInaccuracies([])
    setLastErrorDrop(null)
    setFreeplayMoves([])
    setViewIndex(null)
    postOpeningPlayerCount.current = 0
    computerMoving.current = false
    cgApiRef.current = null
  }, [moveTree])

  // ── Clear arrows and exit browse mode whenever phase changes ────────────────
  useEffect(() => {
    cgApiRef.current?.setAutoShapes([])
    setBoardShapes([])
    setViewIndex(null)
  }, [phase])

  // ── Derived values ───────────────────────────────────────────────────────────
  const currentNode   = path[path.length - 1]
  const movesPlayed   = path.length - 1
  const turnColor: 'white' | 'black' = movesPlayed % 2 === 0 ? 'white' : 'black'
  const isPlayerTurn  = turnColor === playerColor

  /** FEN of the position currently on-screen (respects viewIndex for browsing). */
  const currentBrowseFen = useMemo((): string => {
    if (viewIndex !== null) {
      const treeMoveCount = path.length - 1
      if (viewIndex < treeMoveCount) return path[viewIndex + 1].fen
      return freeplayMoves[viewIndex - treeMoveCount]?.fen ?? currentNode.fen
    }
    if ((phase === 'naming' || phase === 'freeplay') && freeplayFen) return freeplayFen
    return currentNode.fen
  }, [viewIndex, path, freeplayMoves, currentNode, phase, freeplayFen])

  const variationName = useMemo(
    () => ancestorName(path, openingName),
    [path, openingName],
  )

  // ── Dests ────────────────────────────────────────────────────────────────────

  /** Legal destinations in the opening tree (player's turn only). */
  const dests = useMemo(() => {
    if (phase !== 'playing' || !isPlayerTurn || currentNode.children.length === 0)
      return new Map<Key, Key[]>()
    const chess = new Chess(currentNode.fen)
    const map = new Map<Key, Key[]>()
    for (const move of chess.moves({ verbose: true })) {
      const from = move.from as Key
      if (!map.has(from)) map.set(from, [])
      map.get(from)!.push(move.to as Key)
    }
    return map
  }, [phase, isPlayerTurn, currentNode])

  /** All legal destinations in freeplay (player's turn only). */
  const freeplayDests = useMemo(() => {
    if (phase !== 'freeplay' || freeplayBotTurn || !freeplayFen)
      return new Map<Key, Key[]>()
    const chess = new Chess(freeplayFen)
    const map = new Map<Key, Key[]>()
    for (const move of chess.moves({ verbose: true })) {
      const from = move.from as Key
      if (!map.has(from)) map.set(from, [])
      map.get(from)!.push(move.to as Key)
    }
    return map
  }, [phase, freeplayBotTurn, freeplayFen])

  const lastMove: [Key, Key] | undefined =
    path.length > 1
      ? [
          path[path.length - 1].uci.slice(0, 2) as Key,
          path[path.length - 1].uci.slice(2, 4) as Key,
        ]
      : undefined

  // ── cgConfig ─────────────────────────────────────────────────────────────────

  const cgConfig = useMemo((): Config => {
    const orientation = flipped
      ? playerColor === 'white' ? 'black' : 'white'
      : playerColor

    const commonDrawable: Config['drawable'] = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      brushes: {
        hintArrow:    { key: dark ? 'had' : 'hal', color: dark ? '#f0b000' : '#15781B', opacity: dark ? 0.95 : 0.55, lineWidth: dark ? 10 : 7 },
        blunderArrow: { key: 'ba', color: '#cc1111', opacity: 0.70, lineWidth: 8 },
        mistakeArrow: { key: 'ma', color: '#d96000', opacity: 0.70, lineWidth: 8 },
      } as any,
      // Thread shapes through config so chessground's FEN-update path re-applies them
      shapes: boardShapes as any,
    }

    // Browse mode: user clicked a past move — show read-only snapshot
    if (viewIndex !== null) {
      const treeMoveCount = path.length - 1
      let browseFen: string
      if (viewIndex < treeMoveCount) {
        browseFen = path[viewIndex + 1].fen
      } else {
        browseFen = freeplayMoves[viewIndex - treeMoveCount]?.fen ?? currentNode.fen
      }
      const browseChess = new Chess(browseFen)
      return {
        fen: browseFen,
        orientation,
        turnColor: browseChess.turn() === 'w' ? 'white' : 'black',
        coordinates: true,
        animation: { enabled: true, duration: 200 },
        highlight: { lastMove: false, check: true },
        movable: { free: false, color: undefined, dests: new Map() },
        drawable: { ...commonDrawable, shapes: [] },
      }
    }

    // Freeplay: live board driven by freeplayChessRef
    if (phase === 'freeplay' && freeplayFen) {
      const chess = new Chess(freeplayFen)
      const freeplayTurnColor: 'white' | 'black' = chess.turn() === 'w' ? 'white' : 'black'
      return {
        fen: freeplayFen,
        orientation,
        turnColor: freeplayTurnColor,
        lastMove: freeplayLastMove,
        coordinates: true,
        animation: { enabled: true, duration: 200 },
        highlight: { lastMove: true, check: true },
        movable: {
          free: false,
          color: freeplayBotTurn ? undefined : playerColor,
          dests: freeplayDests,
          showDests: true,
        },
        drawable: commonDrawable,
      }
    }

    // Naming / review: board frozen, show last freeplay position
    if ((phase === 'naming' || phase === 'review') && freeplayFen) {
      return {
        fen: freeplayFen,
        orientation,
        lastMove: undefined,          // clear chessground's internal lastMove state
        coordinates: true,
        animation: { enabled: true, duration: 200 },
        highlight: { lastMove: false, check: true }, // disable green square overlay
        movable: { free: false, color: undefined, dests: new Map() },
        drawable: commonDrawable,
      }
    }

    // Normal opening-tree play (setup / playing / naming)
    return {
      fen: currentNode.fen,
      orientation,
      turnColor,
      lastMove,
      coordinates: true,
      animation: { enabled: true, duration: 200 },
      highlight: { lastMove: true, check: true },
      movable: {
        free: false,
        color: phase === 'playing' && isPlayerTurn ? playerColor : undefined,
        dests,
        showDests: true,
      },
      drawable: commonDrawable,
    }
  }, [
    currentNode, turnColor, lastMove, phase, isPlayerTurn,
    playerColor, dests, flipped,
    freeplayFen, freeplayLastMove, freeplayBotTurn, freeplayDests,
    boardShapes, viewIndex, freeplayMoves, path,
  ])

  // ── Freeplay async state-machine ─────────────────────────────────────────────

  /** Launch the naming quiz from freeplay. */
  function triggerNamingFromFreeplay(): void {
    phaseAfterNaming.current = 'playing'
    const name = freeplayNameRef.current
    const distractors = getDistractors(name, variations, 2)
    setNaming({ choices: shuffle([name, ...distractors]), correct: name })
    setSelectedChoice(null)
    setPhase('naming')
  }

  /** Bot plays one Stockfish move, then either ends the session or hands back
   *  control to the player after pre-analysing the resulting position. */
  async function runBotMove(gen: number): Promise<void> {
    if (gen !== generationRef.current) return
    const engine = engineRef.current
    const chess  = freeplayChessRef.current
    if (!engine || !chess) return

    setFreeplayBotTurn(true)

    let result: EngineResult
    try {
      result = await engine.analyze(chess.fen(), engineConfigRef.current)
    } catch { return }
    if (gen !== generationRef.current) return

    // Handle game-over (no legal moves)
    if (!result.bestMove || result.bestMove === '(none)') {
      triggerNamingFromFreeplay()
      return
    }

    // Apply best move to the live chess instance
    const from  = result.bestMove.slice(0, 2)
    const to    = result.bestMove.slice(2, 4)
    const promo = result.bestMove[4] as string | undefined
    let botMove: ReturnType<Chess['move']>
    try {
      botMove = chess.move({ from, to, promotion: promo ?? 'q' })
    } catch {
      // Invalid best move → game is over
      triggerNamingFromFreeplay()
      return
    }
    if (gen !== generationRef.current) return

    const botFen = chess.fen()
    setFreeplayMoves(prev => [...prev, { san: botMove.san, fen: botFen }])
    setFreeplayFen(botFen)
    setFreeplayLastMove([from as Key, to as Key])
    // Stay locked until pre-analysis completes so evalBeforeRef is always set
    runPreAnalysis(gen)
  }

  /** Analyse the current position so we have an eval baseline for the player's
   *  next move.  Keeps the board locked until analysis completes. */
  async function runPreAnalysis(gen: number): Promise<void> {
    if (gen !== generationRef.current) return
    const engine = engineRef.current
    const chess  = freeplayChessRef.current
    if (!engine || !chess) return

    let result: EngineResult
    try {
      result = await engine.analyze(chess.fen(), engineConfigRef.current)
    } catch {
      if (gen === generationRef.current) setFreeplayBotTurn(false)
      return
    }
    if (gen !== generationRef.current) return

    evalBeforeRef.current = result
    setFreeplayBotTurn(false)
  }

  /** Transition into freeplay mode.
   *  @param startingFen  FEN at the point the opening tree was exhausted
   *  @param botGoesFirst true when the bot's turn to move comes first
   *  @param name         variation name used in the naming quiz later
   */
  function enterFreeplay(startingFen: string, botGoesFirst: boolean, name: string, seedInaccuracies: Inaccuracy[] = []): void {
    const gen = ++generationRef.current
    freeplayNameRef.current   = name
    inaccuraciesRef.current   = seedInaccuracies
    // Seed with how many moves the player already made in the opening tree,
    // so POST_OPENING_PLAYER_MOVES is the total session cap (tree + freeplay).
    const treeMoveCount = path.length - 1
    postOpeningPlayerCount.current = playerColorRef.current === 'black'
      ? Math.floor(treeMoveCount / 2)
      : Math.ceil(treeMoveCount / 2)
    evalBeforeRef.current     = null

    const chess = new Chess(startingFen)
    freeplayChessRef.current = chess

    // Reuse the pre-warmed engine from startPractice; create fresh only if missing
    if (!engineRef.current) {
      engineRef.current = new StockfishEngine()
      engineConfigRef.current = detectEngineConfig()
    }

    setFreeplayFen(startingFen)
    setFreeplayLastMove(undefined)
    setInaccuracies(seedInaccuracies)
    setPhase('freeplay')

    if (botGoesFirst) {
      runBotMove(gen)
    } else {
      setFreeplayBotTurn(true)
      runPreAnalysis(gen)
    }
  }

  // ── Opening-tree effects ─────────────────────────────────────────────────────

  // Player's turn and the tree is exhausted → enter freeplay (player moves first)
  useEffect(() => {
    if (phase !== 'playing' || !isPlayerTurn || currentNode.children.length > 0) return
    if (viewIndex !== null) return  // don't transition while user is browsing history
    const name = ancestorName(path, openingName)
    const fen  = currentNode.fen
    const timer = setTimeout(() => enterFreeplay(fen, false, name), 400)
    return () => clearTimeout(timer)
  }, [phase, isPlayerTurn, currentNode, viewIndex]) // eslint-disable-line react-hooks/exhaustive-deps

  // Computer's turn
  useEffect(() => {
    if (phase !== 'playing' || isPlayerTurn || computerMoving.current) return
    if (viewIndex !== null) return  // don't auto-play while user is browsing history

    if (currentNode.children.length === 0) {
      // Tree exhausted on bot's turn → enter freeplay (bot moves first)
      computerMoving.current = true
      const name = ancestorName(path, openingName)
      const fen  = currentNode.fen
      const timer = setTimeout(() => {
        computerMoving.current = false
        enterFreeplay(fen, true, name)
      }, 400)
      return () => { clearTimeout(timer); computerMoving.current = false }
    }

    computerMoving.current = true
    const timer = setTimeout(() => {
      const child = currentNode.children[
        Math.floor(Math.random() * currentNode.children.length)
      ]
      setPath(p => [...p, child])
      setLastResult('idle')
      computerMoving.current = false
    }, 550)
    return () => { clearTimeout(timer); computerMoving.current = false }
  }, [phase, isPlayerTurn, currentNode, viewIndex]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Move handlers ────────────────────────────────────────────────────────────

  /** Handle a move while following the opening tree. */
  const handlePlayingMove = useCallback((orig: Key, dest: Key) => {
    if (!isPlayerTurn || phase !== 'playing') return
    const uci = orig + dest
    const child =
      currentNode.children.find(c => c.uci === uci) ??
      currentNode.children.find(c => c.uci === uci + 'q')

    if (!child) {
      // Show hint arrow for the first book move via React state so the shape
      // survives cgConfig re-applications (which clear drawable.shapes on FEN updates).
      // This also guarantees a re-render that re-applies cgConfig with the correct
      // FEN — reverting the board — even when lastResult is already 'wrong'.
      const hintShapes: { orig: Key; dest: Key; brush: string }[] = []
      if (currentNode.children.length > 0) {
        const hint = currentNode.children[0]
        hintShapes.push({
          orig: hint.uci.slice(0, 2) as Key,
          dest: hint.uci.slice(2, 4) as Key,
          brush: 'hintArrow',
        })
      }
      setBoardShapes(hintShapes)
      setLastResult('wrong')
      return
    }

    // Correct move — clear any hint arrow that was shown
    setBoardShapes([])
    setLastResult('correct')
    const newPath = [...path, child]
    setPath(newPath)

    if (child.children.length === 0) {
      const capturedGen = generationRef.current
      setTimeout(() => {
        if (capturedGen !== generationRef.current) return
        const name = ancestorName(newPath, openingName)
        enterFreeplay(child.fen, false, name)
      }, 400)
    } else {
      setTimeout(() => setLastResult('idle'), 600)
    }
  }, [isPlayerTurn, phase, currentNode, path, openingName]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Handle a move during freeplay — evaluates with Stockfish and classifies it. */
  const handleFreeplayMove = useCallback((orig: Key, dest: Key) => {
    if (phase !== 'freeplay' || freeplayBotTurn) return
    const gen    = generationRef.current
    const chess  = freeplayChessRef.current
    const engine = engineRef.current
    if (!chess || !engine) return

    const fenBefore = chess.fen()
    const preEval   = evalBeforeRef.current
    evalBeforeRef.current = null

    // Apply the move to the live board immediately
    let move: ReturnType<Chess['move']>
    try {
      move = chess.move({ from: orig as string, to: dest as string, promotion: 'q' })
    } catch { return }
    if (!move) return

    const fenAfter    = chess.fen()
    const movePlayed  = orig + dest
    const moveSan     = move.san

    setFreeplayFen(fenAfter)
    setFreeplayLastMove([orig, dest])
    setFreeplayBotTurn(true)   // lock board while we evaluate

    ;(async () => {
      let evalAfter: EngineResult
      try {
        evalAfter = await engine.analyze(fenAfter, engineConfigRef.current)
      } catch { return }
      if (gen !== generationRef.current) return

      // ── Classify the move ────────────────────────────────────────────────
      if (preEval) {
        const evalBeforeScore = evalToCp(preEval)
        const evalAfterScore  = evalToCp(evalAfter)
        const drop            = evalDropForPlayer(evalBeforeScore, evalAfterScore, playerColorRef.current)
        const classification  = classifyMove(drop)

        if (classification === 'inaccuracy' || classification === 'mistake' || classification === 'blunder') {
          // Record for review regardless of severity
          const bestMoveSan  = uciToSan(fenBefore, preEval.bestMove)
          const evalBeforeCp = playerColorRef.current === 'white' ? evalBeforeScore : -evalBeforeScore
          const entry: Inaccuracy = {
            classification,
            fenBefore,
            bestMove:    preEval.bestMove,
            bestMoveSan,
            movePlayed,
            moveSan,
            evalDrop:    drop,
            evalBeforeCp,
          }
          inaccuraciesRef.current = [...inaccuraciesRef.current, entry]
          setInaccuracies(inaccuraciesRef.current)

          // Block on blunders (≥1.5 pawns) and mistakes (≥0.5 pawns) — player must retry
          if (classification === 'blunder' || classification === 'mistake') {
            setLastResult(classification)
            setLastErrorDrop(drop)

            const threatFrom = evalAfter.bestMove?.slice(0, 2) as Key | undefined
            const threatTo   = evalAfter.bestMove?.slice(2, 4) as Key | undefined
            if (threatFrom && threatTo && evalAfter.bestMove !== '(none)') {
              // Set via React state so the shape survives the next FEN-triggered
              // chessground.set() call (which would otherwise wipe drawable.shapes)
              const brush = classification === 'blunder' ? 'blunderArrow' : 'mistakeArrow'
              setBoardShapes([{ orig: threatFrom, dest: threatTo, brush }])
            }

            // After 2 s: revert board and let player retry
            setTimeout(() => {
              if (gen !== generationRef.current) return
              chess.undo()
              evalBeforeRef.current = preEval   // restore eval baseline
              cgApiRef.current?.setAutoShapes([])
              setBoardShapes([])
              setFreeplayFen(fenBefore)
              setFreeplayLastMove(undefined)
              setFreeplayBotTurn(false)          // unlock board
            }, 2000)
            return
          }
        }
      }

      // ── Bot's reply ──────────────────────────────────────────────────────
      // Record player's move in the history strip (only on non-blunder path)
      setFreeplayMoves(prev => [...prev, { san: moveSan, fen: fenAfter }])
      setFreeplayFen(chess.fen())
      postOpeningPlayerCount.current++
      if (postOpeningPlayerCount.current >= POST_OPENING_PLAYER_MOVES) {
        triggerNamingFromFreeplay()
        return
      }
      await runBotMove(gen)
    })()
  }, [phase, freeplayBotTurn]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Unified move handler dispatched from ChessBoard. */
  const handleMove = useCallback((orig: Key, dest: Key) => {
    if (phase === 'playing') handlePlayingMove(orig, dest)
    else if (phase === 'freeplay') handleFreeplayMove(orig, dest)
  }, [phase, handlePlayingMove, handleFreeplayMove])

  // ── Named actions ────────────────────────────────────────────────────────────

  const selectChoice = useCallback((choice: string) => {
    if (selectedChoice) return
    setSelectedChoice(choice)
    if (naming && choice === naming.correct) setScore(s => s + 1)
  }, [naming, selectedChoice])

  /** Called when the user clicks "Continue" or "Skip" on the naming screen. */
  const proceed = useCallback(() => {
    // Cleanup engine, start fresh round with the same side
    generationRef.current++
    engineRef.current?.destroy()
    engineRef.current = null
    freeplayChessRef.current = null
    inaccuraciesRef.current = []

    setPath([moveTree])
    setPhase('playing')
    setLastResult('idle')
    setNaming(null)
    setSelectedChoice(null)
    setFreeplayFen(null)
    setFreeplayLastMove(undefined)
    setFreeplayBotTurn(false)
    setInaccuracies([])
    setLastErrorDrop(null)
    setBoardShapes([])
    setFreeplayMoves([])
    setViewIndex(null)
    postOpeningPlayerCount.current = 0
    computerMoving.current = false
  }, [moveTree])

  const goToMove = useCallback((index: number | null) => {
    setViewIndex(index)
    setBoardShapes([])  // clear hint/blunder arrows while browsing
  }, [])

  const showHint = useCallback(() => {
    const api = cgApiRef.current
    if (!api || !currentNode.children.length) return
    const child = currentNode.children[0]
    api.setShapes([{
      orig: child.uci.slice(0, 2) as Key,
      dest: child.uci.slice(2, 4) as Key,
      brush: 'blue',
    }])
  }, [currentNode])

  const startPractice = useCallback((color: PlayerColor) => {
    generationRef.current++
    engineRef.current?.destroy()
    // Pre-warm: start loading the WASM now so it's ready when freeplay begins
    engineRef.current = new StockfishEngine()
    engineConfigRef.current = detectEngineConfig()
    freeplayChessRef.current = null
    inaccuraciesRef.current = []
    cgApiRef.current?.setAutoShapes([])

    playerColorRef.current = color
    setPlayerColor(color)
    setPath([moveTree])
    setPhase('playing')
    setLastResult('idle')
    setLastErrorDrop(null)
    setNaming(null)
    setSelectedChoice(null)
    setScore(0)
    setFreeplayFen(null)
    setFreeplayLastMove(undefined)
    setFreeplayBotTurn(false)
    setInaccuracies([])
    setBoardShapes([])
    setFreeplayMoves([])
    setViewIndex(null)
    postOpeningPlayerCount.current = 0
    computerMoving.current = false
  }, [moveTree])

  const reset = useCallback(() => {
    generationRef.current++
    engineRef.current?.destroy()
    engineRef.current = null
    freeplayChessRef.current = null
    inaccuraciesRef.current = []
    cgApiRef.current?.setAutoShapes([])

    setPath([moveTree])
    setPhase('setup')
    setLastResult('idle')
    setNaming(null)
    setSelectedChoice(null)
    setScore(0)
    setFreeplayFen(null)
    setFreeplayLastMove(undefined)
    setFreeplayBotTurn(false)
    setInaccuracies([])
    setLastErrorDrop(null)
    setBoardShapes([])
    setFreeplayMoves([])
    setViewIndex(null)
    postOpeningPlayerCount.current = 0
    computerMoving.current = false
  }, [moveTree])

  const setCgApi = useCallback((api: Api) => { cgApiRef.current = api }, [])

  // ── Return ────────────────────────────────────────────────────────────────────

  return {
    phase,
    playerColor,
    variationName,
    cgConfig,
    lastResult,
    lastErrorDrop,
    isPlayerTurn,
    score,
    naming,
    selectedChoice,
    inaccuracies,
    freeplayBotTurn,
    path,
    freeplayMoves,
    viewIndex,
    currentBrowseFen,
    handleMove,
    selectChoice,
    proceed,
    goToMove,
    showHint,
    startPractice,
    reset,
    setCgApi,
  }
}

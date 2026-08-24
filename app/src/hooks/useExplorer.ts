import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Api } from '@lichess-org/chessground/api'
import type { Config } from '@lichess-org/chessground/config'
import type { Key } from '@lichess-org/chessground/types'
import { Chess } from 'chess.js'
import {
  ancestorName,
  pgnToUciMoves,
  type OpeningData,
  type OpeningVariation,
  type MoveNode,
} from '@/data/openings'

export interface FreeMove {
  uci: string
  san: string
  fen: string
}

function hintShapes(node: MoveNode) {
  return node.children.map(c => ({
    orig: c.uci.slice(0, 2) as Key,
    dest: c.uci.slice(2, 4) as Key,
    brush: 'hintArrow',
  }))
}

/** Compute all legal destinations for a given FEN. */
function allLegalDests(fen: string): Map<Key, Key[]> {
  const chess = new Chess(fen)
  const map = new Map<Key, Key[]>()
  for (const move of chess.moves({ verbose: true })) {
    const from = move.from as Key
    if (!map.has(from)) map.set(from, [])
    map.get(from)!.push(move.to as Key)
  }
  return map
}

export function useExplorer(flipped: boolean, showHints: boolean, openingData: OpeningData, openingName: string, dark = false) {
  const { variations, moveTree } = openingData

  const [path, setPath]               = useState<MoveNode[]>([moveTree])
  const [selectedName, setSelectedName] = useState<string | null>(null)
  /** Moves played freely beyond (or outside) the opening tree. */
  const [freePath, setFreePath]       = useState<FreeMove[]>([])

  const cgApiRef = useRef<Api | null>(null)

  // Reset when opening changes
  useEffect(() => {
    setPath([moveTree])
    setSelectedName(null)
    setFreePath([])
  }, [moveTree])

  const currentNode  = path[path.length - 1]
  const inFreeExplore = freePath.length > 0

  // Active FEN — last free-explore move if active, otherwise last tree node
  const currentFen = inFreeExplore
    ? freePath[freePath.length - 1].fen
    : currentNode.fen

  // Turn colour derived directly from the FEN (authoritative)
  const turnColor: 'white' | 'black' =
    currentFen.split(' ')[1] === 'w' ? 'white' : 'black'

  const currentUcis = useMemo(() => path.slice(1).map(n => n.uci), [path])

  const matchingVariations = useMemo(() => {
    return variations.filter(v => {
      if (v.uciMoves.length < currentUcis.length) return false
      return currentUcis.every((uci, i) => v.uciMoves[i] === uci)
    })
  }, [variations, currentUcis])

  const selectedVariation: OpeningVariation | null = useMemo(() => {
    if (matchingVariations.length === 0) return null
    const byName = selectedName
      ? matchingVariations.find(v => v.name === selectedName) ?? null
      : null
    return byName ?? matchingVariations[0]
  }, [matchingVariations, selectedName])

  // All legal moves from the current position (enables free exploration)
  const dests = useMemo(() => allLegalDests(currentFen), [currentFen])

  const lastMove: [Key, Key] | undefined = useMemo(() => {
    if (freePath.length > 0) {
      const last = freePath[freePath.length - 1]
      return [last.uci.slice(0, 2) as Key, last.uci.slice(2, 4) as Key]
    }
    if (path.length > 1) {
      return [
        path[path.length - 1].uci.slice(0, 2) as Key,
        path[path.length - 1].uci.slice(2, 4) as Key,
      ]
    }
    return undefined
  }, [path, freePath])

  const cgConfig = useMemo(
    (): Config => ({
      fen: currentFen,
      orientation: flipped ? 'black' : 'white',
      turnColor,
      lastMove,
      coordinates: true,
      animation: { enabled: true, duration: 200 },
      highlight: { lastMove: true, check: true },
      movable: {
        free: false,
        color: turnColor,
        dests: dests as Map<Key, Key[]>,
        showDests: true,
      },
      drawable: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        brushes: { hintArrow: { key: dark ? 'had' : 'hal', color: dark ? '#f0b000' : '#15781B', opacity: dark ? 0.95 : 0.55, lineWidth: dark ? 10 : 7 } } as any,
      },
    }),
    [currentFen, turnColor, lastMove, dests, flipped, dark],
  )

  const variationName = useMemo(() => ancestorName(path, openingName), [path, openingName])

  const moveLine = useMemo(() => {
    const parts: string[] = []
    for (let i = 1; i < path.length; i++) {
      const isWhite = i % 2 === 1
      if (isWhite) parts.push(`${Math.ceil(i / 2)}.`)
      parts.push(path[i].san)
    }
    for (let i = 0; i < freePath.length; i++) {
      const halfMoves = (path.length - 1) + i
      const isWhite = halfMoves % 2 === 0
      if (isWhite) parts.push(`${Math.floor(halfMoves / 2) + 1}.`)
      parts.push(freePath[i].san)
    }
    return parts.join(' ')
  }, [path, freePath])

  // ── Hint arrows ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const api = cgApiRef.current
    if (!api) return
    // Hide hints during free exploration — no tree structure to hint
    if (!showHints || inFreeExplore) { api.setAutoShapes([]); return }
    api.setAutoShapes(hintShapes(currentNode))
  }, [showHints, currentNode, inFreeExplore, dark])

  const setCgApi = useCallback((api: Api) => {
    cgApiRef.current = api
    if (showHints && !inFreeExplore) api.setAutoShapes(hintShapes(currentNode))
  }, [showHints, currentNode, inFreeExplore])

  // ── Move handler ─────────────────────────────────────────────────────────────

  const handleMove = useCallback((orig: Key, dest: Key) => {
    const uci = orig + dest

    if (!inFreeExplore) {
      // Follow the opening tree if the move matches a child
      const child =
        currentNode.children.find(c => c.uci === uci) ??
        currentNode.children.find(c => c.uci === uci + 'q')
      if (child) {
        setPath(p => [...p, child])
        return
      }
    }

    // Free exploration: apply the move to the live board position
    const fen = inFreeExplore ? freePath[freePath.length - 1].fen : currentNode.fen
    try {
      const chess = new Chess(fen)
      const move  = chess.move({ from: orig as string, to: dest as string, promotion: 'q' })
      if (!move) return
      setFreePath(fp => [...fp, { uci, san: move.san, fen: chess.fen() }])
    } catch { /* illegal move */ }
  }, [currentNode, inFreeExplore, freePath])

  // ── Navigation ───────────────────────────────────────────────────────────────

  const goBack = useCallback(() => {
    if (freePath.length > 0) {
      setFreePath(fp => fp.slice(0, -1))
    } else {
      setPath(p => p.length > 1 ? p.slice(0, -1) : p)
    }
  }, [freePath.length])

  const goForward = useCallback(() => {
    // Forward only works within the opening tree
    if (inFreeExplore) return
    setPath(currentPath => {
      const node = currentPath[currentPath.length - 1]
      if (!selectedVariation) {
        if (node.children.length > 0) return [...currentPath, node.children[0]]
        return currentPath
      }
      const nextUci = selectedVariation.uciMoves[currentPath.length - 1]
      if (!nextUci) return currentPath
      const child = node.children.find(c => c.uci === nextUci)
      return child ? [...currentPath, child] : currentPath
    })
  }, [selectedVariation, inFreeExplore])

  /**
   * Go to a specific move index in the combined history.
   * Indices 1..path.length-1  → tree moves (clears freePath)
   * Indices path.length..     → free explore moves (truncates freePath)
   */
  const goToIndex = useCallback((index: number) => {
    if (index < path.length) {
      setPath(p => p.slice(0, index + 1))
      setFreePath([])
    } else {
      const freeCount = index - path.length + 1
      setFreePath(fp => fp.slice(0, freeCount))
    }
  }, [path.length])

  const jumpToVariation = useCallback((variation: OpeningVariation) => {
    const uciMoves = pgnToUciMoves(variation.pgn)
    const newPath: MoveNode[] = [moveTree]
    let node = moveTree
    for (const uci of uciMoves) {
      const child = node.children.find(c => c.uci === uci)
      if (!child) break
      newPath.push(child)
      node = child
    }
    setPath(newPath)
    setSelectedName(variation.name)
    setFreePath([])   // return to tree mode
  }, [moveTree])

  const reset = useCallback(() => {
    setPath([moveTree])
    setSelectedName(null)
    setFreePath([])
  }, [moveTree])

  // ── Derived flags ────────────────────────────────────────────────────────────

  const canGoBack = path.length > 1 || freePath.length > 0
  const canGoForward = !inFreeExplore && (
    selectedVariation
      ? currentUcis.length < selectedVariation.uciMoves.length
      : currentNode.children.length > 0
  )

  return {
    path,
    freePath,
    inFreeExplore,
    currentNode,
    currentFen,   // the actual board FEN — may differ from currentNode.fen in free explore
    variationName,
    moveLine,
    cgConfig,
    handleMove,
    goBack,
    goForward,
    jumpToVariation,
    reset,
    setCgApi,
    canGoBack,
    canGoForward,
    matchingVariations,
    selectedVariation,
    depth: currentUcis.length,
    showHints,
    goToIndex,
    setSelectedVariation: (v: OpeningVariation) => {
      setSelectedName(v.name)
      setFreePath([])   // clicking a variation exits free explore
    },
  }
}

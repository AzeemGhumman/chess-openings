import { useEffect, useRef, useState } from 'react'

export interface StockfishEval {
  score: number | null      // centipawns, from white's perspective
  mate: number | null       // moves to mate (positive = white mates, negative = black mates)
  depth: number
  bestMove: string | null   // UCI move e.g. "e2e4"
}

const IDLE: StockfishEval = { score: null, mate: null, depth: 0, bestMove: null }

function parseInfo(line: string): Partial<StockfishEval> | null {
  if (!line.startsWith('info') || !line.includes('score')) return null
  const result: Partial<StockfishEval> = {}

  const depthMatch = line.match(/\bdepth (\d+)/)
  if (depthMatch) result.depth = parseInt(depthMatch[1])

  const cpMatch = line.match(/\bscore cp (-?\d+)/)
  if (cpMatch) { result.score = parseInt(cpMatch[1]); result.mate = null }

  const mateMatch = line.match(/\bscore mate (-?\d+)/)
  if (mateMatch) { result.mate = parseInt(mateMatch[1]); result.score = null }

  return Object.keys(result).length ? result : null
}

export function useStockfish(fen: string | null, enabled: boolean) {
  const [evaluation, setEvaluation] = useState<StockfishEval>(IDLE)
  const workerRef    = useRef<Worker | null>(null)
  const pendingFen   = useRef<string | null>(null)
  const ready        = useRef(false)
  const currentEval  = useRef<StockfishEval>(IDLE)
  const isSearching  = useRef(false)
  const stopSent     = useRef(false)
  const pendingAnalysis = useRef<string | null>(null)
  const sideToMove   = useRef<'w' | 'b'>('w')

  function startSearch(fenStr: string) {
    const w = workerRef.current
    if (!w) return
    isSearching.current = true
    stopSent.current = false
    sideToMove.current = (fenStr.split(' ')[1] === 'b' ? 'b' : 'w')
    w.postMessage(`position fen ${fenStr}`)
    w.postMessage('go infinite')
  }

  function analyze(fenStr: string) {
    const w = workerRef.current
    if (!w) return
    currentEval.current = IDLE
    setEvaluation(IDLE)

    if (isSearching.current) {
      pendingAnalysis.current = fenStr
      if (!stopSent.current) {
        w.postMessage('stop')
        stopSent.current = true
      }
    } else {
      startSearch(fenStr)
    }
  }

  // Create the worker only when enabled — destroy it when disabled.
  // This ensures only one Stockfish WASM instance runs at a time.
  useEffect(() => {
    if (!enabled) {
      // Tear down any existing worker
      if (workerRef.current) {
        workerRef.current.postMessage('quit')
        workerRef.current.terminate()
        workerRef.current = null
      }
      ready.current = false
      isSearching.current = false
      stopSent.current = false
      pendingAnalysis.current = null
      pendingFen.current = null
      setEvaluation(IDLE)
      return
    }

    const worker = new Worker('/stockfish/stockfish-18-single.js')
    workerRef.current = worker
    ready.current = false
    isSearching.current = false
    stopSent.current = false
    pendingAnalysis.current = null

    worker.onerror = (err) => console.error('[SF] worker error', err)

    worker.onmessage = (e: MessageEvent<string>) => {
      const line = e.data

      if (line === 'readyok') {
        ready.current = true
        if (pendingFen.current) {
          analyze(pendingFen.current)
          pendingFen.current = null
        }
        return
      }

      if (line.startsWith('bestmove')) {
        isSearching.current = false
        stopSent.current = false
        const move = line.split(' ')[1]
        if (move && move !== '(none)') {
          currentEval.current = { ...currentEval.current, bestMove: move }
          setEvaluation({ ...currentEval.current })
        }
        if (pendingAnalysis.current) {
          const next = pendingAnalysis.current
          pendingAnalysis.current = null
          startSearch(next)
        }
        return
      }

      const update = parseInfo(line)
      if (update) {
        if (sideToMove.current === 'b') {
          if (update.score != null) update.score = -update.score
          if (update.mate  != null) update.mate  = -update.mate
        }
        currentEval.current = { ...currentEval.current, ...update }
        setEvaluation({ ...currentEval.current })
      }
    }

    worker.postMessage('uci')
    worker.postMessage('setoption name Hash value 16')
    worker.postMessage('isready')

    return () => {
      worker.postMessage('quit')
      worker.terminate()
      workerRef.current = null
      ready.current = false
      isSearching.current = false
      stopSent.current = false
    }
  }, [enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-analyze whenever FEN changes
  useEffect(() => {
    if (!enabled || !fen) {
      pendingAnalysis.current = null
      if (isSearching.current && !stopSent.current) {
        workerRef.current?.postMessage('stop')
        stopSent.current = true
      }
      setEvaluation(IDLE)
      return
    }
    if (!ready.current) {
      pendingFen.current = fen
      return
    }
    analyze(fen)
  }, [fen, enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  return evaluation
}

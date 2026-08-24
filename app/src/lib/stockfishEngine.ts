// Promise-based wrapper around the single-threaded Stockfish WASM worker.
// Provides sequential analysis (one position at a time).

export interface EngineResult {
  score: number        // centipawns, always white-centric (positive = white winning)
  mate: number | null  // moves to forced mate (positive = white mates, negative = black mates)
  bestMove: string     // UCI move e.g. 'e2e4'
  depth: number
}

export interface EngineConfig {
  /** ms per move — engine stops when time is up and returns best move found so far */
  movetime: number
}

/**
 * Pick movetime based on logical CPU cores.
 * Single-threaded WASM can't use multiple cores, but core count is a reasonable
 * proxy for device class (high-end desktop vs low-end mobile).
 */
export function detectEngineConfig(): EngineConfig {
  const cores = navigator.hardwareConcurrency ?? 2
  if (cores >= 8) return { movetime: 1000 }
  if (cores >= 4) return { movetime: 600 }
  if (cores >= 2) return { movetime: 400 }
  return { movetime: 300 }
}

export type MoveClassification = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder'

/** Centipawn drop from the mover's perspective (positive = bad for the mover). */
export function evalDropForPlayer(
  evalBefore: number,
  evalAfter: number,
  color: 'white' | 'black',
): number {
  if (color === 'white') return evalBefore - evalAfter
  return evalAfter - evalBefore
}

/** Classify a move based on how many centipawns the mover lost. */
export function classifyMove(drop: number): MoveClassification {
  if (drop <= 0)   return 'best'
  if (drop <= 20)  return 'good'
  if (drop <= 50)  return 'inaccuracy'
  if (drop <= 150) return 'mistake'
  return 'blunder'
}

export class StockfishEngine {
  private worker: Worker
  private _ready = false
  private readyQ: (() => void)[] = []
  private analysisResolve: ((r: EngineResult) => void) | null = null
  private analysisReject:  ((e: Error) => void)         | null = null
  private cur: { score: number; mate: number | null; depth: number } = { score: 0, mate: null, depth: 0 }
  private sideMultiplier = 1  // +1 for white to move, -1 for black to move

  constructor() {
    this.worker = new Worker('/stockfish/stockfish-18-single.js')
    this.worker.onmessage  = ({ data }: MessageEvent<string>) => this.handle(data)
    this.worker.onerror    = (e) => { this.analysisReject?.(new Error(String(e.message))); this.analysisReject = null }
    this.worker.postMessage('uci')
    this.worker.postMessage('setoption name Hash value 16')
    this.worker.postMessage('isready')
  }

  private handle(line: string) {
    if (line === 'readyok') {
      this._ready = true
      this.readyQ.forEach(r => r())
      this.readyQ = []
      return
    }

    if (line.startsWith('info') && line.includes('score')) {
      const cp    = line.match(/\bscore cp (-?\d+)/)
      const mate  = line.match(/\bscore mate (-?\d+)/)
      const depth = line.match(/\bdepth (\d+)/)
      // Stockfish scores are from side-to-move's perspective; convert to white-centric
      if (cp)    { this.cur.score = parseInt(cp[1]) * this.sideMultiplier; this.cur.mate = null }
      if (mate)  { this.cur.mate  = parseInt(mate[1]) * this.sideMultiplier }
      if (depth) { this.cur.depth = parseInt(depth[1]) }
    }

    if (line.startsWith('bestmove')) {
      const bestMove = line.split(' ')[1] ?? ''
      this.analysisResolve?.({ ...this.cur, bestMove })
      this.analysisResolve = null
      this.analysisReject  = null
    }
  }

  private waitReady(): Promise<void> {
    if (this._ready) return Promise.resolve()
    return new Promise(resolve => this.readyQ.push(resolve))
  }

  async analyze(fen: string, config: EngineConfig | number = 18): Promise<EngineResult> {
    await this.waitReady()
    this.cur = { score: 0, mate: null, depth: 0 }
    this.sideMultiplier = fen.split(' ')[1] === 'b' ? -1 : 1
    this.worker.postMessage(`position fen ${fen}`)
    const goCmd = typeof config === 'number'
      ? `go depth ${config}`
      : `go movetime ${config.movetime}`
    this.worker.postMessage(goCmd)
    return new Promise((resolve, reject) => {
      this.analysisResolve = resolve
      this.analysisReject  = reject
    })
  }

  destroy() {
    this.analysisReject?.(new Error('Engine destroyed'))
    this.analysisResolve = null
    this.analysisReject  = null
    this.worker.postMessage('quit')
    this.worker.terminate()
  }
}

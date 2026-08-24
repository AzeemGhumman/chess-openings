import { Chess } from 'chess.js'
import bTsv from './b.tsv?raw'

export interface CaroKannVariation {
  eco: string
  name: string
  pgn: string
  shortName: string  // after "Caro-Kann Defense: "
  family: string     // first part before comma
  uciMoves: string[] // pre-computed from pgn
  sanMoves: string[] // pre-computed SAN strings
}

export interface MoveNode {
  uci: string
  san: string
  fen: string
  children: MoveNode[]
  // Named positions at exactly this node (the PGN ends here)
  names: Array<{ eco: string; name: string }>
}

export function pgnToMoves(pgn: string): { uci: string; san: string }[] {
  try {
    const chess = new Chess()
    chess.loadPgn(pgn)
    return chess.history({ verbose: true }).map(m => ({
      uci: m.from + m.to + (m.promotion ?? ''),
      san: m.san,
    }))
  } catch {
    return []
  }
}

export function pgnToUciMoves(pgn: string): string[] {
  return pgnToMoves(pgn).map(m => m.uci)
}

function parseVariations(): CaroKannVariation[] {
  return bTsv
    .trim()
    .split('\n')
    .slice(1)
    .map(line => {
      const parts = line.split('\t')
      const eco = parts[0]?.trim() ?? ''
      const name = parts[1]?.trim() ?? ''
      const pgn = parts[2]?.trim() ?? ''
      const colonIdx = name.indexOf(': ')
      const shortName = colonIdx >= 0 ? name.slice(colonIdx + 2) : name
      const commaIdx = shortName.indexOf(',')
      const family = commaIdx >= 0 ? shortName.slice(0, commaIdx).trim() : shortName
      const moves = pgnToMoves(pgn)
      return { eco, name, pgn, shortName, family, uciMoves: moves.map(m => m.uci), sanMoves: moves.map(m => m.san) }
    })
    .filter(v => v.name.startsWith('Caro-Kann Defense') && v.pgn && v.name.includes(': '))
    .filter((v, i, arr) => arr.findIndex(x => x.name === v.name) === i)
}

function buildTree(variations: CaroKannVariation[]): MoveNode {
  const root: MoveNode = {
    uci: '',
    san: '',
    fen: new Chess().fen(),
    children: [],
    names: [],
  }

  for (const v of variations) {
    const uciMoves = pgnToUciMoves(v.pgn)
    if (!uciMoves.length) continue

    const chess = new Chess()
    let node = root

    for (const uci of uciMoves) {
      let child = node.children.find(c => c.uci === uci)
      if (!child) {
        const from = uci.slice(0, 2)
        const to = uci.slice(2, 4)
        const promo = uci[4] as 'q' | 'r' | 'b' | 'n' | undefined
        const result = chess.move({ from, to, promotion: promo })
        if (!result) break
        child = { uci, san: result.san, fen: chess.fen(), children: [], names: [] }
        node.children.push(child)
      } else {
        chess.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci[4] as 'q' | 'r' | 'b' | 'n' | undefined,
        })
      }
      node = child
    }

    node.names.push({ eco: v.eco, name: v.name })
  }

  return root
}

// Collect every ancestor name along a path (for labelling positions mid-line)
export function ancestorName(path: MoveNode[]): string {
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].names.length > 0) return path[i].names[path[i].names.length - 1].name
  }
  return 'Caro-Kann Defense'
}

// Build dests map from node children (for chessground)
export function childDests(node: MoveNode): Map<string, string[]> {
  const dests = new Map<string, string[]>()
  for (const child of node.children) {
    const from = child.uci.slice(0, 2)
    const to = child.uci.slice(2, 4)
    if (!dests.has(from)) dests.set(from, [])
    dests.get(from)!.push(to)
  }
  return dests
}

export const caroKannVariations: CaroKannVariation[] = parseVariations()
export const moveTree: MoveNode = buildTree(caroKannVariations)

// Unique variation families for grouping
export const variationFamilies = [...new Set(caroKannVariations.map(v => v.family))].sort()

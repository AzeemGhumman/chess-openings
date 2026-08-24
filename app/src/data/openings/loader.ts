import { Chess } from 'chess.js'
import aTsv from '../a.tsv?raw'
import bTsv from '../b.tsv?raw'
import cTsv from '../c.tsv?raw'
import dTsv from '../d.tsv?raw'
import eTsv from '../e.tsv?raw'
import type { OpeningCatalogEntry, TsvFile } from './catalog'
import type { MoveNode, OpeningData, OpeningVariation } from './types'

const TSV_FILES: Record<TsvFile, string> = { a: aTsv, b: bTsv, c: cTsv, d: dTsv, e: eTsv }

const cache = new Map<string, OpeningData>()

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

function parseVariations(raw: string, namePrefix: string): OpeningVariation[] {
  return raw
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
    .filter(v => v.name.startsWith(namePrefix) && v.pgn && v.name.includes(': '))
    .filter((v, i, arr) => arr.findIndex(x => x.name === v.name) === i)
}

function buildTree(variations: OpeningVariation[]): MoveNode {
  const root: MoveNode = {
    uci: '',
    san: '',
    fen: new Chess().fen(),
    children: [],
    names: [],
  }

  for (const v of variations) {
    if (!v.uciMoves.length) continue
    const chess = new Chess()
    let node = root

    for (const uci of v.uciMoves) {
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
        chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] as 'q' | 'r' | 'b' | 'n' | undefined })
      }
      node = child
    }

    node.names.push({ eco: v.eco, name: v.name })
  }

  return root
}

export function loadOpening(entry: OpeningCatalogEntry): OpeningData {
  if (cache.has(entry.id)) return cache.get(entry.id)!
  const raw = TSV_FILES[entry.tsvFile]
  const variations = parseVariations(raw, entry.namePrefix)
  const moveTree = buildTree(variations)
  const data: OpeningData = { variations, moveTree }
  cache.set(entry.id, data)
  return data
}

// Walk a path backwards to find the deepest named position
export function ancestorName(path: MoveNode[], openingName: string): string {
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].names.length > 0) return path[i].names[path[i].names.length - 1].name
  }
  return openingName
}

// Build a dests map from direct children of a node (for chessground movable.dests)
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

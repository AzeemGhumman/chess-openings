export interface OpeningVariation {
  eco: string
  name: string
  pgn: string
  shortName: string
  family: string
  uciMoves: string[]
  sanMoves: string[]
}

export interface MoveNode {
  uci: string
  san: string
  fen: string
  children: MoveNode[]
  names: Array<{ eco: string; name: string }>
}

export interface OpeningData {
  variations: OpeningVariation[]
  moveTree: MoveNode
}

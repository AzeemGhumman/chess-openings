export type TsvFile = 'a' | 'b' | 'c' | 'd' | 'e'

export interface OpeningCatalogEntry {
  id: string
  name: string
  tsvFile: TsvFile
  namePrefix: string
  description?: string
}

// Master list of available openings, in display order.
// To add a new opening: add an entry here — no other files need to change.
// To reorder or categorize: adjust the array order; categories can be added later
// by adding an optional `category` field to OpeningCatalogEntry.
export const OPENING_CATALOG: OpeningCatalogEntry[] = [
  {
    id: 'caro-kann',
    name: 'Caro-Kann Defense',
    tsvFile: 'b',
    namePrefix: 'Caro-Kann Defense',
    description: '1. e4 c6',
  },
  {
    id: 'sicilian',
    name: 'Sicilian Defense',
    tsvFile: 'b',
    namePrefix: 'Sicilian Defense',
    description: '1. e4 c5',
  },
  {
    id: 'french',
    name: 'French Defense',
    tsvFile: 'c',
    namePrefix: 'French Defense',
    description: '1. e4 e6',
  },
  {
    id: 'ruy-lopez',
    name: 'Ruy Lopez',
    tsvFile: 'c',
    namePrefix: 'Ruy Lopez',
    description: '1. e4 e5 2. Nf3 Nc6 3. Bb5',
  },
  {
    id: 'italian',
    name: 'Italian Game',
    tsvFile: 'c',
    namePrefix: 'Italian Game',
    description: '1. e4 e5 2. Nf3 Nc6 3. Bc4',
  },
  {
    id: 'queens-gambit',
    name: "Queen's Gambit",
    tsvFile: 'd',
    namePrefix: "Queen's Gambit",
    description: '1. d4 d5 2. c4',
  },
  {
    id: 'slav',
    name: 'Slav Defense',
    tsvFile: 'd',
    namePrefix: 'Slav Defense',
    description: '1. d4 d5 2. c4 c6',
  },
  {
    id: 'kings-indian',
    name: "King's Indian Defense",
    tsvFile: 'e',
    namePrefix: "King's Indian Defense",
    description: '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7',
  },
  {
    id: 'nimzo-indian',
    name: 'Nimzo-Indian Defense',
    tsvFile: 'e',
    namePrefix: 'Nimzo-Indian Defense',
    description: '1. d4 Nf6 2. c4 e6 3. Nc3 Bb4',
  },
  {
    id: 'english',
    name: 'English Opening',
    tsvFile: 'a',
    namePrefix: 'English Opening',
    description: '1. c4',
  },
]

export const DEFAULT_OPENING_ID = 'caro-kann'

export function getOpeningById(id: string): OpeningCatalogEntry {
  return OPENING_CATALOG.find(e => e.id === id) ?? OPENING_CATALOG[0]
}

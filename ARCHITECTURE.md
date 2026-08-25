# Chess Openings Trainer — Architecture

A single-page React application for learning and practicing chess openings. The user explores opening theory, drills it against a Stockfish bot, and reviews their real games via chess.com integration. All chess computation runs client-side in a WASM worker; a small AWS backend handles user identity and game analysis.

---

## Repository layout

```
chess-openings/
├── app/                        # React frontend (Vite + TypeScript)
│   ├── public/
│   │   ├── stockfish/          # Stockfish 18 WASM + JS loader (108 MB wasm excluded from git)
│   │   └── chessground.*.css   # Board and piece themes
│   └── src/
│       ├── App.tsx             # Root: layout, routing, global auth widget
│       ├── components/
│       │   ├── ChessBoard.tsx  # Thin chessground wrapper with snap and focus
│       │   ├── EvalBar.tsx     # Animated evaluation bar
│       │   ├── InsightsTab.tsx # Chess.com integration + auth flow
│       │   ├── PracticePanel.tsx # Naming quiz UI
│       │   └── SettingsPanel.tsx # Opening selector
│       ├── hooks/
│       │   ├── useExplorer.ts  # Explorer mode state machine
│       │   ├── usePractice.ts  # Practice mode state machine
│       │   ├── useStockfish.ts # Reactive Stockfish evaluator
│       │   ├── usePreferences.ts # Persisted user preferences (localStorage)
│       │   └── useTheme.ts     # Dark/light mode (class toggle + localStorage)
│       ├── lib/
│       │   ├── stockfishEngine.ts # Stockfish singleton + move classifier
│       │   └── session.ts         # Google session storage + cross-tab broadcast
│       └── data/openings/
│           ├── catalog.ts      # Registry of supported openings
│           ├── types.ts        # OpeningData, MoveNode, OpeningVariation
│           └── loader.ts       # TSV → move tree parser (runs once at import)
├── analysis/
│   └── AWS/                    # SAM application: Lambda + DynamoDB + SQS
│       ├── template.yaml       # Infrastructure as code
│       └── src/                # Python Lambda handlers
└── .github/workflows/
    └── deploy.yml              # CI/CD: build → S3 sync → CloudFront invalidation
```

---

## Frontend

### Tech stack

| Concern | Choice | Reason |
|---|---|---|
| UI framework | React 18 | Hooks-first; fine-grained re-renders for the board |
| Build tool | Vite 6 | Fast HMR; native ESM; easy WASM/worker config |
| Styling | Tailwind CSS 3 | Utility-first; dark mode via `dark:` variants |
| Chess board | `@lichess-org/chessground` (local) | Lichess's production board; pointer-events model allows custom snap logic |
| Chess logic | `chess.js` | Move validation, FEN/SAN/UCI conversion, legal-move generation |
| Engine | Stockfish 18 WASM (single-threaded) | Strongest freely available engine; runs entirely in browser |
| Icons | `lucide-react` | Tree-shakeable; consistent stroke style |
| Component primitives | Radix UI (Slot, Tabs) | Unstyled; composable; accessibility built in |

### Routing

Hash-based (`#/practice`, `#/explorer`, `#/insights`, `#/settings`). No router library — `modeFromHash()` reads `window.location.hash` on load; a `hashchange` listener keeps React state in sync. Enables back/forward navigation without a server redirect.

### State management

No global store (no Redux, Zustand, etc.). State lives in three layers:

1. **URL hash** — current mode; shareable/bookmarkable
2. **`localStorage`** — preferences (`usePreferences`) and auth session (`session.ts`)
3. **React hook state** — everything else, scoped to the hook that owns it

`App.tsx` composes the three major hooks (`useExplorer`, `usePractice`, `useStockfish`) and passes slices down as props. This keeps hooks independent and testable in isolation.

---

## Opening data pipeline

### Source format

Each supported opening (e.g. Caro-Kann) is a TSV file (`data/a.tsv` … `data/e.tsv`) derived from the [chess-openings](https://github.com/lichess-org/chess-openings) dataset. Columns: `eco`, `name`, `pgn`, `uci`, `epd`.

### Parsing (`loader.ts`)

On first import of an opening, `loadOpening(entry)` runs once and is memoised by `useMemo` in `App.tsx`:

1. Filter the master TSV rows to the ECO codes registered in `catalog.ts` for that opening.
2. Parse UCI move strings into `OpeningVariation[]` (flat list — one row per named line).
3. Build a **move tree** (`MoveNode`): starting from the root position, insert each variation's moves one by one, sharing common prefixes. Each node stores `uci`, `san`, `fen`, `children[]`, and the ECO name tags that terminate there.

The move tree is the authoritative data structure used by both Explorer and Practice. Flat variations are kept alongside it for the naming quiz and variation table.

### Opening catalog (`catalog.ts`)

A registry of `{ id, name, description, ecoPrefix[] }` entries. Adding a new opening means adding an entry here; the loader handles the rest.

---

## Explorer mode (`useExplorer`)

The Explorer lets the user walk the opening tree freely, see hints, and optionally get live Stockfish evaluations.

### State machine

```
currentNode (MoveNode)
    │
    ├── handleMove(uci)
    │       ├── match in currentNode.children → advance node, record path
    │       └── no match → offbook: switch to freeMode, append to freePath
    │
    ├── goBack() / goForward()   → navigate path[] / freePath[]
    └── goToMove(index)          → jump to any historical position
```

`path[]` is the sequence of `MoveNode` objects from root to the current position. `freePath[]` holds moves played after leaving the tree. Resetting to any in-tree position clears `freePath`.

### Hints

When `showHints` is on, chessground's `drawable.autoShapes` is populated with arrows for each legal child of the current node, coloured by frequency in the dataset (not implemented explicitly — all children get equal weight currently).

### Eval bar

`useStockfish(currentFen, enabled)` — a separate hook that owns one `StockfishEngine` instance and re-analyzes whenever the FEN changes. The result feeds `<EvalBar>`. The engine is only created when `evalEnabled` is true, so it doesn't burn CPU during Practice.

---

## Practice mode (`usePractice`)

The most complex piece of the app. A full state machine driving an interactive training session.

### Phases

```
setup
  └─ startPractice(color)
        └─ playing
              └─ (tree exhausted or branch end)
                    └─ freeplay
                          └─ (10 player moves, or game over)
                                └─ naming
                                      └─ proceed()
                                            └─ playing  (new session)
```

#### `setup`
Initial screen. Player picks White or Black. The choice determines who moves first and which side the board is flipped to.

#### `playing`
Player follows the opening tree. The hook compares each move against `currentNode.children`:
- **Correct** → advance the node; if it's the bot's turn, play the first (only) child automatically after a short delay.
- **Wrong** → flash feedback, reset position, let player retry. No state change.
- **Off-book** → record as an inaccuracy, transition to `freeplay` at the current position.
- **Tree end** → transition to `freeplay`.

#### `freeplay`
Post-opening free play. The bot plays Stockfish's best move; the player responds freely.

**Move evaluation pipeline** (per player move):
1. Board locks immediately (`freeplayBotTurn = true`).
2. `preEval` (the position's eval *before* the player moved) was stored by `runPreAnalysis`, which ran — while the board was locked — after the previous bot move. This guarantees `preEval` is always set when the player moves (race condition fixed).
3. After the player's move, run `engine.analyze(fenAfter)` to get `evalAfter`.
4. `classifyMove(preEval, evalAfter, playerColor)` computes centipawn drop from the player's perspective and returns `'inaccuracy' | 'mistake' | 'blunder'` (or `null`).
5. **Blunder or mistake** (≥ 50 cp drop): show a coloured arrow pointing to the engine's best move, revert the position after 2 s, restore `preEval`, unlock the board so the player retries.
6. **Inaccuracy** (< 50 cp drop): record silently, play on.
7. After 10 player moves, trigger `naming`.

**Why lock the board during pre-analysis**: The original design unlocked immediately after the bot moved, then ran pre-analysis in the background. If the player moved before analysis completed, `preEval` was null and no classification happened — any move passed silently. Locking until `runPreAnalysis` resolves (`setFreeplayBotTurn(false)` is now called exclusively by `runPreAnalysis`) eliminates this race.

#### `naming`
Multiple-choice quiz: "Which variation did you play?" Choices are the correct variation name plus up to 3 distractors drawn randomly from the opening's other variations. After answering (or skipping), `proceed()` resets to a new `playing` session.

### Eval bar in practice

A second `useStockfish` instance (`practiceEval`) is activated only during `naming`. It evaluates `practice.currentBrowseFen` — updated as the user browses the move list — and feeds the same `<EvalBar>` component. This gives the retrospective evaluation reveal without burning CPU during active play.

### Generation counter (`generationRef`)

Every async operation (engine analysis, bot move timeouts) checks `gen !== generationRef.current` before committing state. `generationRef` is incremented on every `startPractice` / `resetPractice` call. This prevents stale async callbacks from a previous session from corrupting the current one.

### Board interaction (`ChessBoard.tsx`)

Chessground places `pointer-events: none` on piece elements; all pointer events land on `cg-board`. `ChessBoard` adds a capture-phase `pointerdown` listener that:

1. If `.selected` exists on the board (a piece is already selected for a 2-click move), does nothing — lets the event reach the board as a destination click.
2. Otherwise, checks if the pointer landed directly on a piece bounding box. If yes, does nothing.
3. If the pointer missed all pieces but is within one square of the nearest piece, re-dispatches the event at the piece's center — lenient "snap to nearest" behaviour.

---

## Stockfish integration

### Engine singleton (`stockfishEngine.ts`)

`StockfishEngine` wraps a `stockfish.js` Worker:
- **Auto-detects** whether the WASM build is available (via `WebAssembly` presence), falls back to pure JS.
- Exposes a single `analyze(fen, config): Promise<EngineResult>` method.
- Internally sequences commands: `position fen <fen>` → `go depth <d>` → parse `info` lines for `score cp`/`score mate`/`bestmove`.
- Only one analysis runs at a time; a new call aborts the previous by sending `stop`.

### Move classifier (`classifyMove`)

```
evalDrop = evalToCp(preEval) - evalToCp(evalAfter)   // from player's perspective
```

| Drop | Classification |
|---|---|
| < 20 cp | — (good move) |
| 20–49 cp | `inaccuracy` |
| 50–149 cp | `mistake` |
| ≥ 150 cp | `blunder` |

Mate scores are normalised to ±10 000 cp for comparison.

### Engine config

`detectEngineConfig()` runs once on mount and caps depth at 15 on lower-powered devices (heuristic: navigator.hardwareConcurrency ≤ 4 or User-Agent mobile). Full depth is 18. MultiPV is always 1 in practice; the explorer eval bar also uses depth 18.

---

## Authentication & session

### Google Sign-In

Uses the Google Identity Services library loaded from a `<script>` tag. The `GlobalAuthWidget` in `App.tsx` handles sign-in prompts and renders the avatar + dropdown when signed in. `decodeGoogleCredential` (in `InsightsTab.tsx`) base64-decodes the JWT payload — no cryptographic verification client-side; the backend verifies the token on profile fetch.

### Session storage (`session.ts`)

`StoredSession` (`{ user, idToken, chesscomUsername? }`) is written to `localStorage` as JSON. `loadSession()` checks token expiry (decoded from the JWT `exp` claim) and returns null if expired. `broadcastSession(s)` fires a custom `chess-session` DOM event so `GlobalAuthWidget` and `InsightsTab` stay in sync without prop drilling across the component tree.

### InsightsTab auth states

```
idle
  └─ Google login
        └─ loading-profile  (spinner shown here)
              ├─ GET /api/me → no chess.com username cached
              │     └─ authenticated (show username form)
              └─ GET /api/me → username present
                    └─ connected (show game analysis)
```

The `loading-profile` state was added to avoid flashing the "enter username" form during the async `/api/me` fetch that happens immediately after login.

---

## Backend (AWS)

A SAM application deployed separately from the frontend. The frontend calls it at `https://wl5joz6sg0.execute-api.us-east-1.amazonaws.com/prod` (proxied through Vite as `/api` in development).

### Resources

| Resource | Purpose |
|---|---|
| `GetMeSummary` Lambda | Returns the signed-in user's profile and chess.com username from DynamoDB |
| `UpdateUser` Lambda | Upserts user record (called from `ProfileModal` when chess.com username changes) |
| `GetUserGames` Lambda | Fetches recent games from the chess.com public API |
| `SubmitAnalyzeJob` Lambda | Enqueues an SQS message to trigger background analysis |
| `AnalyzeUserGamesWorker` Lambda | SQS consumer: runs `python-chess` analysis on fetched games, writes results to DynamoDB |
| `GoogleAuthorizer` Lambda | API Gateway Lambda Authorizer: verifies Google `idToken` on protected routes |
| DynamoDB `UsersTable` | User profiles keyed by Google `sub` |
| DynamoDB `GamesTable` | Analyzed game results |
| SQS queue | Decouples game fetch from analysis; allows retries |
| Stockfish Lambda Layer | Native Stockfish binary for server-side analysis (108 MB, excluded from git) |

### API Gateway

All routes except `POST /auth` are protected by the `GoogleAuthorizer`. The authorizer extracts the Bearer token from `Authorization`, validates it against Google's public keys (fetched from `https://www.googleapis.com/oauth2/v3/certs`), and returns an IAM policy.

---

## Deployment

### Frontend CI/CD (`.github/workflows/deploy.yml`)

On every push to `main`:

1. `npm ci` — install dependencies
2. Configure AWS credentials from GitHub Secrets (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
3. Download `stockfish-18-single.wasm` from S3 — the 108 MB WASM is too large for git; it lives permanently in the S3 bucket and is fetched as a build-time asset
4. `npm run build` — TypeScript check + Vite production bundle
5. `aws s3 sync app/dist s3://chess-azeemghumman --delete`
6. `aws cloudfront create-invalidation --distribution-id E4PRH9O5BBRSP --paths "/*"`

The IAM user used by CI has a minimal policy: `s3:ListBucket`, `s3:GetObject/PutObject/DeleteObject` on the bucket, and `cloudfront:CreateInvalidation` on the specific distribution. No other AWS access.

### Infrastructure

| Resource | Value |
|---|---|
| S3 bucket | `chess-azeemghumman` (static website hosting) |
| CloudFront distribution | `E4PRH9O5BBRSP` (`d2054nx0y52set.cloudfront.net`) |
| AWS region | `us-east-1` |
| AWS profile (local) | `personal` |

---

## Key design decisions

**No router library.** Hash-based routing with a 20-line helper is sufficient for four views and avoids a dependency and a server-side redirect requirement.

**No state management library.** Each mode has one hook that owns all its state. `App.tsx` composes them. The only cross-cutting state (session, theme, preferences) uses `localStorage` + a custom DOM event bus (`broadcastSession`).

**Stockfish runs entirely in the browser.** No server round-trip for move evaluation during practice. The trade-off is a 108 MB WASM download on first load (cached aggressively by CloudFront), and weaker analysis on mobile due to single-threaded WASM.

**Move tree built at parse time, not runtime.** `loadOpening` runs once and memoises the result. Navigating the tree, generating hints, and checking moves are all O(branching-factor) lookups with no parsing overhead.

**Generation counter for async safety.** All async callbacks (engine analysis, timeouts) carry a `gen` snapshot captured at dispatch time. If `gen !== generationRef.current` when the callback fires, it is a stale result from a previous session and is discarded. This eliminates a class of "ghost move" bugs where analysis from one session contaminated the next.

**Board lock during pre-analysis.** After the bot plays, `freeplayBotTurn` stays `true` until `runPreAnalysis` resolves. This ensures `preEval` (the position score before the player moves) is always available for move classification. Unlocking early would create a race where fast players bypass evaluation entirely.

**Chessground snap-to-nearest.** Chessground puts `pointer-events: none` on pieces; clicks land on the board element. A capture-phase `pointerdown` listener re-dispatches events at the center of the nearest piece when the pointer misses by less than one square. The listener skips this logic when `.selected` is present on the board, preserving 2-click move semantics.

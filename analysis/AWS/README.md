# AWS SAM Stack (API + Lambda + DynamoDB)

This folder contains a complete SAM app for:

- API Gateway
- 4 Lambda functions (including Google token authorizer + async worker)
- 2 DynamoDB tables
- 1 SQS queue

## Resources

### Tables

1. `chess-opening-user-games`
   - Partition key: `username` (String)
   - Sort key: `game_timestamp` (Number)
   - Query with `ScanIndexForward=false` to get latest first.

2. `chess-opening-users`
   - Partition key: `email` (String)
   - Stores user profile + account mappings (`chess_com_username`, optional `lichess_username`, `name`).

Both tables are configured with:

- `DeletionPolicy: Retain`
- `UpdateReplacePolicy: Retain`

This ensures table data is not deleted/reset on stack updates or accidental replacement.

## Authentication (Google Sign-In)

API methods are protected by a Lambda authorizer that validates Google ID tokens.

Frontend must send:

- `Authorization: Bearer <google_id_token>`

Set allowed Google OAuth client IDs in Lambda env:

- `GOOGLE_CLIENT_IDS` (comma-separated list)

Example:

- `GOOGLE_CLIENT_IDS=123.apps.googleusercontent.com,456.apps.googleusercontent.com`

Security model:

- API does **not** trust email in request body.
- It uses authenticated `email` claim from verified Google token.

## API Endpoints

Base URL:

`https://{api-id}.execute-api.{region}.amazonaws.com/prod`

### 1) Update user info

- `POST /user`
- Lambda: `chess-opening-update-user`
- Uses authenticated email from token claims.

Body example:

```json
{
  "name": "Azeem",
  "chess_com_username": "AzeemGhumman3",
  "lichess_username": "optional_for_future"
}
```

### 2) Analyze user games

- `POST /analyze-user-games`
- Lambda: `chess-opening-submit-analyze-job` (lightweight submitter)
- Uses authenticated email from token claims.
- Cooldown: one accepted analyze request per user per 60 minutes.

Body example:

```json
{}
```

Flow:

1. Submitter Lambda reads authenticated email from authorizer context.
2. Finds user in `chess-opening-users` by email and reads `chess_com_username`.
3. Sends async job message to SQS queue `chess-opening-analyze-jobs`.
4. Worker Lambda `chess-opening-analyze-user-games-worker` consumes jobs.
5. Worker analyzes hardcoded last `X` games with Stockfish and writes rows into `chess-opening-user-games`.

Response from `/analyze-user-games` is immediate (`202 Accepted`) with `job_id`.

If another analyze request is made within 60 minutes of the previous accepted request, API returns:

- HTTP `429`
- Message indicating how many minutes remain before the next request is allowed.

### 3) Fetch analyzed games (paginated)

- `GET /user-games`
- Lambda: `chess-opening-get-user-games`
- Uses authenticated email from token claims.
- Reads `chess_com_username` from `chess-opening-users`.
- Queries `chess-opening-user-games` by partition key (`username`) with `ScanIndexForward=false` (latest first).
- No table scans are used.

Query params:

- `limit` (optional): number of games to return, default `10`, max `50`
- `next_token` (optional): opaque cursor from previous response
- `offset` (optional): skip top `N` most recent games (useful for initial offset pagination)
  - If `next_token` is provided, do not provide `offset`.

Response includes:

- `games` array sorted newest first
- `next_token` for next page
- each game includes `pgn_compact` so frontend can replay moves

### 4) Fetch login bootstrap summary

- `GET /me/summary`
- Lambda: `chess-opening-get-me-summary`
- Uses authenticated email from token claims.

Returns:

- profile data from `chess-opening-users` (`name`, usernames, last analyze timestamp)
- `analyzed_games_count` (count of analyzed games for mapped chess.com user)
- `latest_game` (most recent analyzed game, or `null`)

## Hardcoded analysis settings

Configured as Lambda environment variables in `template.yaml`:

- `ANALYZE_GAMES_COUNT=100`
- `ANALYZE_TIME_CONTROL=blitz`
- `ANALYZE_DEPTH=12`
- `ANALYZE_MISTAKE_THRESHOLD=100`
- `ANALYZE_BLUNDER_THRESHOLD=300`

You can change these in `template.yaml` and redeploy.

## Stockfish

`AnalyzeUserGamesFunction` expects Stockfish at:

- `STOCKFISH_PATH=/opt/stockfish/stockfish`

This SAM stack already defines and attaches a `StockfishLayer` to `AnalyzeUserGamesWorkerFunction`.

To use it:

1. Put binary at:
   - `analysis/AWS/layers/stockfish/stockfish/stockfish`
2. Make it executable:
   - `chmod +x analysis/AWS/layers/stockfish/stockfish/stockfish`
3. Deploy stack (`sam build && sam deploy`).

If you prefer packaging the binary inside function code, update `STOCKFISH_PATH` accordingly.

## Frontend changes

For each API request:

1. User signs in with Google (existing flow).
2. Frontend gets Google ID token.
3. Frontend sends:
   - `Authorization: Bearer <id_token>`
4. Call `POST /user` and `POST /analyze-user-games`.

No IAM SigV4 request signing is required in browser.

## Deploy

From this folder (`analysis/AWS`):

```bash
sam build
sam deploy --guided
```

On subsequent deploys:

```bash
sam build && sam deploy
```

## Notes

- Table data remains intact across code pushes/deploys due retain policies.
- Per-function dependencies:
  - `src/google_authorizer/requirements.txt` -> `google-auth`
  - `src/analyze_user_games/requirements.txt` -> `python-chess`
  - `src/submit_analyze_job/` uses runtime `boto3` only (no extra pip deps)

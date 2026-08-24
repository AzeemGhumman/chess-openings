# Find Players by Rating Buckets

This tool samples Chess.com users and finds players near rating bucket centers.

## Goal

For each bucket center (for example 100, 200, ..., 3000), collect up to N players:

- rating within `center +/- tolerance` (default `+/-10`)
- at least `min-games` in selected time control (default `blitz`, min 100 games)

## Strategy

Because Chess.com API does not directly support "find users by rating", this uses a graph-sampling approach:

1. Start from seed usernames.
2. Validate each user via `/stats`.
3. If user fits a bucket and bucket is not full, select them.
4. Fetch recent games for that user and enqueue opponents.
5. Repeat until all buckets are full, frontier is exhausted, or API budget is hit.

This is a best-effort sampler. Low/high rating buckets can take longer to fill.

## Usage

From repo root:

```bash
python analysis/find-players/find_players.py --time-control blitz --output analysis/find-players/players.csv
```

More exhaustive run:

```bash
python analysis/find-players/find_players.py \
  --time-control blitz \
  --players-per-bucket 10 \
  --min-rating 100 \
  --max-rating 3000 \
  --bucket-step 100 \
  --tolerance 10 \
  --min-games 100 \
  --games-per-user-scan 80 \
  --max-api-calls 12000 \
  --output analysis/find-players/players.csv
```

## Output CSV columns

- `bucket_center`
- `username`
- `rating`
- `games_played`

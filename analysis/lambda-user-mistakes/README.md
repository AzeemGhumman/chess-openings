# Lambda: User Mistake Analysis

This folder contains an AWS Lambda implementation that analyzes a Chess.com user's recent games and returns JSON.

## What It Does

- Input: Chess.com username and analysis options
- Fetches the user's last `N` games for one time control
- Uses Stockfish to detect the first move where the user makes a mistake or blunder
- Returns results as JSON (no CSV writing in this Lambda)

## Files

- `handler.py` - Lambda handler (`lambda_handler`)
- `requirements.txt` - Python dependencies

## Request Payload

Supports direct Lambda invoke payload or API Gateway JSON body:

```json
{
  "username": "hikaru",
  "games": 10,
  "time_control": "blitz",
  "depth": 12,
  "mistake_threshold": 100,
  "blunder_threshold": 300
}
```

## Response Shape

```json
{
  "username": "hikaru",
  "time_control": "blitz",
  "games_requested": 10,
  "games_analyzed": 10,
  "depth": 12,
  "mistake_threshold": 100,
  "blunder_threshold": 300,
  "results": [
    {
      "game_url": "...",
      "first_error_type": "mistake",
      "move_number": 12,
      "ply": 24
    }
  ]
}
```

## Environment Variable

- `STOCKFISH_PATH` (optional)
  - Default: `/opt/stockfish/stockfish`
  - Set this to where Stockfish binary exists in Lambda runtime/layer.

## Deployment Notes

1. Package Python deps from `requirements.txt`.
2. Include Stockfish binary in:
   - a Lambda Layer (recommended), or
   - the Lambda zip itself.
3. Set handler to:
   - `handler.lambda_handler`

## Local Smoke Test

From repo root:

```bash
python3 - <<'PY'
import importlib.util
import pathlib

handler_path = pathlib.Path("analysis/lambda-user-mistakes/handler.py")
spec = importlib.util.spec_from_file_location("lambda_handler_module", handler_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
event = {
    "username": "hikaru",
    "games": 5,
    "time_control": "blitz",
}
print(mod.lambda_handler(event, None))
PY
```

If running locally, ensure Stockfish is installed and `STOCKFISH_PATH` points to it.

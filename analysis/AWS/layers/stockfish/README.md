# Stockfish Lambda Layer

Place the Linux Stockfish binary at:

- `analysis/AWS/layers/stockfish/stockfish/stockfish`

Requirements:

- binary must be executable (`chmod +x stockfish`)
- binary must match Lambda architecture/runtime (Amazon Linux compatible)

The analyze lambda expects:

- `STOCKFISH_PATH=/opt/stockfish/stockfish`

When deployed via SAM, this layer mounts under `/opt`.

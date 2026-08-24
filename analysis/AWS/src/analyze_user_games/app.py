import datetime as dt
import io
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal
from typing import Optional

import boto3
import chess
import chess.engine
import chess.pgn


ARCHIVES_URL_TEMPLATE = "https://api.chess.com/pub/player/{username}/games/archives"
USER_AGENT = "chess-opening-analyze-user-games/1.0"
MATE_SCORE_CP = 100_000
TIME_CONTROL_OPTIONS = {"bullet", "blitz", "rapid", "daily"}

USER_GAMES_TABLE_NAME = os.environ["USER_GAMES_TABLE_NAME"]
STOCKFISH_PATH = os.environ.get("STOCKFISH_PATH", "/opt/stockfish/stockfish")

ANALYZE_GAMES_COUNT = int(os.environ.get("ANALYZE_GAMES_COUNT", "100"))
ANALYZE_TIME_CONTROL = os.environ.get("ANALYZE_TIME_CONTROL", "blitz")
ANALYZE_DEPTH = int(os.environ.get("ANALYZE_DEPTH", "12"))
ANALYZE_MISTAKE_THRESHOLD = int(os.environ.get("ANALYZE_MISTAKE_THRESHOLD", "100"))
ANALYZE_BLUNDER_THRESHOLD = int(os.environ.get("ANALYZE_BLUNDER_THRESHOLD", "300"))

ddb = boto3.resource("dynamodb")
user_games_table = ddb.Table(USER_GAMES_TABLE_NAME)


class HttpFetchError(RuntimeError):
    def __init__(self, status_code: int, url: str):
        super().__init__(f"HTTP {status_code} fetching {url}")
        self.status_code = status_code
        self.url = url


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=20) as response_:
            return json.loads(response_.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise HttpFetchError(exc.code, url) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Network error fetching {url}: {exc.reason}") from exc


def get_last_games(username: str, max_games: int, time_control: str) -> list[dict]:
    archives_url = ARCHIVES_URL_TEMPLATE.format(username=urllib.parse.quote(username))
    archives_data = fetch_json(archives_url)
    archives = archives_data.get("archives", [])
    if not archives:
        return []

    games: list[dict] = []
    for archive_url in reversed(archives):
        try:
            month_data = fetch_json(archive_url)
        except HttpFetchError as exc:
            if exc.status_code == 404:
                continue
            raise
        for game in reversed(month_data.get("games", [])):
            if game.get("time_class", "") != time_control:
                continue
            games.append(game)
            if len(games) >= max_games:
                return games
    return games


def normalize_username(value: Optional[str]) -> str:
    return (value or "").strip().lower()


def player_color(game_json: dict, username: str) -> Optional[chess.Color]:
    target = normalize_username(username)
    white_name = normalize_username(game_json.get("white", {}).get("username"))
    black_name = normalize_username(game_json.get("black", {}).get("username"))
    if white_name == target:
        return chess.WHITE
    if black_name == target:
        return chess.BLACK
    return None


def cp_eval(engine: chess.engine.SimpleEngine, board: chess.Board, limit: chess.engine.Limit) -> int:
    info = engine.analyse(board, limit)
    score = info["score"].white()
    return score.score(mate_score=MATE_SCORE_CP)


def classify_drop(delta_cp: int, mistake_cp: int, blunder_cp: int) -> Optional[str]:
    if delta_cp <= -blunder_cp:
        return "blunder"
    if delta_cp <= -mistake_cp:
        return "mistake"
    return None


def find_first_mistake(
    game: chess.pgn.Game,
    engine: chess.engine.SimpleEngine,
    target_color: chess.Color,
    limit: chess.engine.Limit,
    mistake_cp: int,
    blunder_cp: int,
) -> Optional[dict]:
    board = game.board()
    ply = 0
    for move in game.mainline_moves():
        ply += 1
        if board.turn != target_color:
            board.push(move)
            continue

        move_number = board.fullmove_number
        san = board.san(move)
        eval_before_for_target = cp_eval(engine, board, limit)
        if target_color == chess.BLACK:
            eval_before_for_target *= -1

        board.push(move)

        eval_after_for_target = cp_eval(engine, board, limit)
        if target_color == chess.BLACK:
            eval_after_for_target *= -1

        delta_cp = eval_after_for_target - eval_before_for_target
        error_type = classify_drop(delta_cp, mistake_cp, blunder_cp)
        if error_type:
            return {
                "error_type": error_type,
                "move_number": move_number,
                "ply": ply,
                "san": san,
                "eval_before_cp": eval_before_for_target,
                "eval_after_cp": eval_after_for_target,
                "delta_cp": delta_cp,
            }
    return None


def parse_pgn(pgn_text: str) -> Optional[chess.pgn.Game]:
    stream = io.StringIO(pgn_text)
    return chess.pgn.read_game(stream)


def compact_pgn(pgn_text: str) -> str:
    game = parse_pgn(pgn_text)
    if game is None:
        return ""
    exporter = chess.pgn.StringExporter(headers=True, variations=False, comments=False, columns=None)
    return game.accept(exporter).strip()


def to_iso_utc(timestamp: Optional[int]) -> str:
    if not timestamp:
        return ""
    return dt.datetime.fromtimestamp(timestamp, dt.UTC).isoformat().replace("+00:00", "Z")


def to_decimal(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, list):
        return [to_decimal(v) for v in value]
    if isinstance(value, dict):
        return {k: to_decimal(v) for k, v in value.items()}
    return value


def analyze_and_store_games(username: str) -> dict:
    games = get_last_games(username, ANALYZE_GAMES_COUNT, ANALYZE_TIME_CONTROL)
    if not games:
        return {
            "username": username,
            "games_requested": ANALYZE_GAMES_COUNT,
            "games_fetched": 0,
            "games_saved": 0,
            "time_control": ANALYZE_TIME_CONTROL,
        }

    engine = chess.engine.SimpleEngine.popen_uci(STOCKFISH_PATH)
    saved = 0
    limit = chess.engine.Limit(depth=ANALYZE_DEPTH)
    try:
        for g in games:
            pgn_text = g.get("pgn")
            if not pgn_text:
                continue

            color = player_color(g, username)
            if color is None:
                continue

            game = parse_pgn(pgn_text)
            if game is None:
                continue

            first_error = find_first_mistake(
                game=game,
                engine=engine,
                target_color=color,
                limit=limit,
                mistake_cp=ANALYZE_MISTAKE_THRESHOLD,
                blunder_cp=ANALYZE_BLUNDER_THRESHOLD,
            )

            game_timestamp = int(g.get("end_time", 0) or 0)
            if game_timestamp <= 0:
                continue

            white_name = g.get("white", {}).get("username", "")
            black_name = g.get("black", {}).get("username", "")
            opponent = black_name if color == chess.WHITE else white_name
            user_result = g.get("white", {}).get("result", "") if color == chess.WHITE else g.get("black", {}).get("result", "")
            user_rating = g.get("white", {}).get("rating", "") if color == chess.WHITE else g.get("black", {}).get("rating", "")
            game_url = g.get("url", "")
            timestamp_game_id = f"{game_timestamp}#{game_url}" if game_url else str(game_timestamp)

            item = {
                "username": username,
                "game_timestamp": game_timestamp,
                "timestamp_game_id": timestamp_game_id,
                "game_url": game_url,
                "pgn_compact": compact_pgn(pgn_text),
                "end_time_iso": to_iso_utc(game_timestamp),
                "time_class": g.get("time_class", ""),
                "rules": g.get("rules", ""),
                "user_color": "white" if color == chess.WHITE else "black",
                "user_rating": int(user_rating) if str(user_rating).isdigit() else None,
                "opponent_username": opponent,
                "user_result": user_result,
                "first_error_type": (first_error or {}).get("error_type", "none"),
                "first_error": first_error,
                "analyzed_at": dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z"),
            }

            user_games_table.put_item(Item=to_decimal(item))
            saved += 1
    finally:
        engine.quit()

    return {
        "username": username,
        "games_requested": ANALYZE_GAMES_COUNT,
        "games_fetched": len(games),
        "games_saved": saved,
        "time_control": ANALYZE_TIME_CONTROL,
        "depth": ANALYZE_DEPTH,
        "mistake_threshold": ANALYZE_MISTAKE_THRESHOLD,
        "blunder_threshold": ANALYZE_BLUNDER_THRESHOLD,
    }


def process_job(payload: dict) -> dict:
    chess_username = normalize_username(payload.get("chess_com_username") or payload.get("username") or "")
    if not chess_username:
        raise ValueError("Job payload missing chess_com_username")
    summary = analyze_and_store_games(chess_username)
    summary["job_id"] = payload.get("job_id")
    summary["email"] = payload.get("email")
    return summary


def lambda_handler(event, context):
    if ANALYZE_TIME_CONTROL not in TIME_CONTROL_OPTIONS:
        raise ValueError(f"Invalid ANALYZE_TIME_CONTROL: {ANALYZE_TIME_CONTROL}")

    # SQS-triggered async mode
    records = (event or {}).get("Records") if isinstance(event, dict) else None
    if isinstance(records, list) and records:
        processed: list[dict] = []
        for record in records:
            body = record.get("body", "{}")
            payload = json.loads(body) if isinstance(body, str) else (body or {})
            processed.append(process_job(payload if isinstance(payload, dict) else {}))
        return {"ok": True, "processed": processed}

    # Optional direct invoke mode for diagnostics
    payload = event if isinstance(event, dict) else {}
    return {"ok": True, "processed": [process_job(payload)]}

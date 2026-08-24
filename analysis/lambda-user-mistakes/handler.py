import datetime as dt
import io
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from typing import Optional

import chess
import chess.engine
import chess.pgn


ARCHIVES_URL_TEMPLATE = "https://api.chess.com/pub/player/{username}/games/archives"
USER_AGENT = "chess-mistake-lambda/1.0"
MATE_SCORE_CP = 100_000
TIME_CONTROL_OPTIONS = {"bullet", "blitz", "rapid", "daily"}


class HttpFetchError(RuntimeError):
    def __init__(self, status_code: int, url: str):
        super().__init__(f"HTTP {status_code} fetching {url}")
        self.status_code = status_code
        self.url = url


@dataclass
class MistakeEvent:
    error_type: str
    move_number: int
    ply: int
    san: str
    eval_before_cp: int
    eval_after_cp: int
    delta_cp: int


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
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
) -> Optional[MistakeEvent]:
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
            return MistakeEvent(
                error_type=error_type,
                move_number=move_number,
                ply=ply,
                san=san,
                eval_before_cp=eval_before_for_target,
                eval_after_cp=eval_after_for_target,
                delta_cp=delta_cp,
            )
    return None


def parse_pgn(pgn_text: str) -> Optional[chess.pgn.Game]:
    stream = io.StringIO(pgn_text)
    return chess.pgn.read_game(stream)


def iso_from_unix(timestamp: Optional[int]) -> str:
    if not timestamp:
        return ""
    return dt.datetime.fromtimestamp(timestamp, dt.UTC).isoformat().replace("+00:00", "Z")


def analyze_games(
    username: str,
    games_json: list[dict],
    engine: chess.engine.SimpleEngine,
    depth: int,
    mistake_cp: int,
    blunder_cp: int,
) -> list[dict]:
    rows: list[dict] = []
    limit = chess.engine.Limit(depth=depth)

    for idx, g in enumerate(games_json, start=1):
        pgn_text = g.get("pgn")
        if not pgn_text:
            continue

        color = player_color(g, username)
        if color is None:
            continue

        game = parse_pgn(pgn_text)
        if game is None:
            continue

        event = find_first_mistake(game, engine, color, limit, mistake_cp, blunder_cp)
        white_name = g.get("white", {}).get("username", "")
        black_name = g.get("black", {}).get("username", "")
        opponent = black_name if color == chess.WHITE else white_name
        user_result = g.get("white", {}).get("result", "") if color == chess.WHITE else g.get("black", {}).get("result", "")
        user_rating = g.get("white", {}).get("rating", "") if color == chess.WHITE else g.get("black", {}).get("rating", "")

        row = {
            "game_index": idx,
            "game_url": g.get("url", ""),
            "end_time": iso_from_unix(g.get("end_time")),
            "time_class": g.get("time_class", ""),
            "rules": g.get("rules", ""),
            "username": username,
            "user_color": "white" if color == chess.WHITE else "black",
            "user_rating": user_rating,
            "opponent_username": opponent,
            "user_result": user_result,
            "first_error_type": event.error_type if event else "none",
            "move_number": event.move_number if event else None,
            "ply": event.ply if event else None,
            "san": event.san if event else "",
            "eval_before_cp": event.eval_before_cp if event else None,
            "eval_after_cp": event.eval_after_cp if event else None,
            "delta_cp": event.delta_cp if event else None,
            "first_error": asdict(event) if event else None,
        }
        rows.append(row)
    return rows


def parse_event(event: dict) -> dict:
    body = event
    if "body" in event and isinstance(event["body"], str):
        body = json.loads(event["body"] or "{}")

    username = (body.get("username") or "").strip()
    if not username:
        raise ValueError("username is required")

    games = int(body.get("games", 10))
    depth = int(body.get("depth", 12))
    time_control = (body.get("time_control") or "blitz").strip().lower()
    mistake_threshold = int(body.get("mistake_threshold", 100))
    blunder_threshold = int(body.get("blunder_threshold", 300))

    if games <= 0:
        raise ValueError("games must be > 0")
    if depth <= 0:
        raise ValueError("depth must be > 0")
    if time_control not in TIME_CONTROL_OPTIONS:
        raise ValueError(f"time_control must be one of: {', '.join(sorted(TIME_CONTROL_OPTIONS))}")
    if mistake_threshold <= 0 or blunder_threshold <= 0:
        raise ValueError("mistake_threshold and blunder_threshold must be > 0")
    if blunder_threshold < mistake_threshold:
        raise ValueError("blunder_threshold must be >= mistake_threshold")

    return {
        "username": username,
        "games": games,
        "depth": depth,
        "time_control": time_control,
        "mistake_threshold": mistake_threshold,
        "blunder_threshold": blunder_threshold,
    }


def response(status_code: int, payload: dict) -> dict:
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(payload),
    }


def lambda_handler(event, context):
    try:
        params = parse_event(event if isinstance(event, dict) else {})
        username = params["username"]
        games = get_last_games(username, params["games"], params["time_control"])
        if not games:
            return response(
                200,
                {
                    "username": username,
                    "time_control": params["time_control"],
                    "games_requested": params["games"],
                    "games_analyzed": 0,
                    "results": [],
                },
            )

        stockfish_path = os.getenv("STOCKFISH_PATH", "/opt/stockfish/stockfish")
        try:
            engine = chess.engine.SimpleEngine.popen_uci(stockfish_path)
        except FileNotFoundError as exc:
            raise RuntimeError(f"Stockfish binary not found at {stockfish_path}") from exc

        try:
            results = analyze_games(
                username=username,
                games_json=games,
                engine=engine,
                depth=params["depth"],
                mistake_cp=params["mistake_threshold"],
                blunder_cp=params["blunder_threshold"],
            )
        finally:
            engine.quit()

        return response(
            200,
            {
                "username": username,
                "time_control": params["time_control"],
                "games_requested": params["games"],
                "games_analyzed": len(results),
                "depth": params["depth"],
                "mistake_threshold": params["mistake_threshold"],
                "blunder_threshold": params["blunder_threshold"],
                "results": results,
            },
        )
    except ValueError as exc:
        return response(400, {"error": str(exc)})
    except HttpFetchError as exc:
        status_code = 404 if exc.status_code == 404 else 502
        return response(status_code, {"error": str(exc)})
    except Exception as exc:
        return response(500, {"error": str(exc)})

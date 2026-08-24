#!/usr/bin/env python3
import argparse
import csv
import datetime as dt
import io
import json
import time
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

import chess
import chess.engine
import chess.pgn


ARCHIVES_URL_TEMPLATE = "https://api.chess.com/pub/player/{username}/games/archives"
USER_AGENT = "chess-mistake-analyzer/1.0"
MATE_SCORE_CP = 100_000
TIME_CONTROL_OPTIONS = ("bullet", "blitz", "rapid", "daily")


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


@dataclass
class PeerStats:
    username_norm: str
    display_username: str
    games_played: int = 0
    rating_gap_total: int = 0
    rating_gap_samples: int = 0
    last_seen_ts: int = 0

    @property
    def avg_rating_gap(self) -> float:
        if self.rating_gap_samples == 0:
            return float("inf")
        return self.rating_gap_total / self.rating_gap_samples


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
            # Chess.com archives can include newer month URLs before games exist.
            # Skip missing months and keep searching older archives for enough games.
            if exc.status_code == 404:
                continue
            raise
        month_games = month_data.get("games", [])
        for game in reversed(month_games):
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


def opponent_username(game_json: dict, username: str) -> str:
    color = player_color(game_json, username)
    if color == chess.WHITE:
        return game_json.get("black", {}).get("username", "")
    if color == chess.BLACK:
        return game_json.get("white", {}).get("username", "")
    return ""


def build_peer_stats(games: Iterable[dict], username: str) -> dict[str, PeerStats]:
    stats_by_user: dict[str, PeerStats] = {}
    target = normalize_username(username)

    for game in games:
        color = player_color(game, username)
        if color is None:
            continue
        opponent = (opponent_username(game, username) or "").strip()
        if not opponent:
            continue
        opponent_norm = normalize_username(opponent)
        if not opponent_norm or opponent_norm == target:
            continue

        stats = stats_by_user.setdefault(
            opponent_norm,
            PeerStats(username_norm=opponent_norm, display_username=opponent),
        )

        if color == chess.WHITE:
            user_rating = int(game.get("white", {}).get("rating", 0) or 0)
            opp_rating = int(game.get("black", {}).get("rating", 0) or 0)
        else:
            user_rating = int(game.get("black", {}).get("rating", 0) or 0)
            opp_rating = int(game.get("white", {}).get("rating", 0) or 0)

        stats.games_played += 1
        if user_rating > 0 and opp_rating > 0:
            stats.rating_gap_total += abs(user_rating - opp_rating)
            stats.rating_gap_samples += 1
        end_time = int(game.get("end_time", 0) or 0)
        stats.last_seen_ts = max(stats.last_seen_ts, end_time)
        stats.display_username = opponent
    return stats_by_user


def rank_peers_by_rating_closeness(peer_stats: dict[str, PeerStats]) -> list[PeerStats]:
    ranked = sorted(
        peer_stats.values(),
        key=lambda s: (s.avg_rating_gap, -s.games_played, -s.last_seen_ts, s.username_norm),
    )
    return ranked


def select_peer_usernames(games: Iterable[dict], username: str, peers: int) -> list[str]:
    if peers <= 0:
        return []
    stats_by_user = build_peer_stats(games, username)
    ranked = rank_peers_by_rating_closeness(stats_by_user)
    return [s.display_username for s in ranked[:peers]]


def dedupe_games(games: Iterable[dict], seen_game_keys: set[str]) -> list[dict]:
    unique_games: list[dict] = []
    for game in games:
        game_key = (
            str(game.get("url", "")).strip()
            or str(game.get("uuid", "")).strip()
            or str(game.get("pgn", "")).strip()
        )
        if not game_key or game_key in seen_game_keys:
            continue
        seen_game_keys.add(game_key)
        unique_games.append(game)
    return unique_games


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
    return dt.datetime.utcfromtimestamp(timestamp).isoformat() + "Z"


def rows_from_games(
    basic_username: str,
    detailed_username: str,
    games_json: Iterable[dict],
    engine: chess.engine.SimpleEngine,
    depth: int,
    mistake_cp: int,
    blunder_cp: int,
) -> tuple[list[dict], list[float]]:
    rows: list[dict] = []
    analysis_times_sec: list[float] = []
    limit = chess.engine.Limit(depth=depth)
    for idx, g in enumerate(games_json, start=1):
        pgn_text = g.get("pgn")
        if not pgn_text:
            continue

        color = player_color(g, detailed_username)
        if color is None:
            continue

        game = parse_pgn(pgn_text)
        if game is None:
            continue

        started_at = time.perf_counter()
        event = find_first_mistake(game, engine, color, limit, mistake_cp, blunder_cp)
        analysis_times_sec.append(time.perf_counter() - started_at)
        white_name = g.get("white", {}).get("username", "")
        black_name = g.get("black", {}).get("username", "")
        opponent = black_name if color == chess.WHITE else white_name
        user_result = g.get("white", {}).get("result", "") if color == chess.WHITE else g.get("black", {}).get("result", "")
        if color == chess.WHITE:
            player_rating = int(g.get("white", {}).get("rating", 0) or 0)
        else:
            player_rating = int(g.get("black", {}).get("rating", 0) or 0)

        row = {
            "basic_analysis_username": basic_username,
            "detailed_analysis_username": detailed_username,
            "player_rating": player_rating if player_rating > 0 else "",
            "game_index": idx,
            "game_url": g.get("url", ""),
            "end_time": iso_from_unix(g.get("end_time")),
            "time_class": g.get("time_class", ""),
            "rules": g.get("rules", ""),
            "user_color": "white" if color == chess.WHITE else "black",
            "opponent_username": opponent,
            "user_result": user_result,
            "first_error_type": event.error_type if event else "none",
            "move_number": event.move_number if event else "",
            "ply": event.ply if event else "",
            "san": event.san if event else "",
            "eval_before_cp": event.eval_before_cp if event else "",
            "eval_after_cp": event.eval_after_cp if event else "",
            "delta_cp": event.delta_cp if event else "",
        }
        rows.append(row)
    return rows, analysis_times_sec


def write_csv(path: str, rows: list[dict]) -> None:
    fieldnames = [
        "basic_analysis_username",
        "detailed_analysis_username",
        "player_rating",
        "game_index",
        "game_url",
        "end_time",
        "time_class",
        "rules",
        "user_color",
        "opponent_username",
        "user_result",
        "first_error_type",
        "move_number",
        "ply",
        "san",
        "eval_before_cp",
        "eval_after_cp",
        "delta_cp",
    ]
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def output_csv_path(output_dir: str) -> str:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    folder_name = output_path.name
    if not folder_name:
        raise ValueError("--output must be a valid folder path")

    return str(output_path / f"{folder_name}.csv")


def load_usernames_from_csv(csv_path: str) -> list[str]:
    path = Path(csv_path)
    if not path.is_file():
        raise FileNotFoundError(f"User list CSV not found: {csv_path}")

    usernames: list[str] = []
    seen: set[str] = set()
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        if "username" not in (reader.fieldnames or []):
            raise ValueError("User list CSV must contain a 'username' column")
        for row in reader:
            username = (row.get("username") or "").strip()
            if not username:
                continue
            key = normalize_username(username)
            if not key or key in seen:
                continue
            seen.add(key)
            usernames.append(username)
    return usernames


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Fetch last Chess.com games for a player and detect the first "
            "mistake/blunder in each game using Stockfish."
        )
    )
    parser.add_argument("--username", help="Chess.com username")
    parser.add_argument(
        "--user-list-csv",
        help=(
            "Optional CSV with a 'username' column. If provided, analyze these users "
            "instead of --username/--peers expansion."
        ),
    )
    parser.add_argument(
        "--engine-path",
        required=True,
        help="Path to Stockfish binary (for example: /opt/homebrew/bin/stockfish)",
    )
    parser.add_argument("--games", type=int, default=10, help="Number of recent games to analyze (default: 10)")
    parser.add_argument(
        "--peers",
        type=int,
        default=0,
        help=(
            "Number of closest opponents from the base user's last X games. "
            "For each selected peer, analyze their last X games too (default: 0)"
        ),
    )
    parser.add_argument(
        "--time-control",
        choices=TIME_CONTROL_OPTIONS,
        default="blitz",
        help=(
            "Single game time control to include "
            f"(options: {', '.join(TIME_CONTROL_OPTIONS)}; default: blitz)"
        ),
    )
    parser.add_argument("--depth", type=int, default=12, help="Stockfish search depth (default: 12)")
    parser.add_argument(
        "--mistake-threshold",
        type=int,
        default=100,
        help="Centipawn drop threshold for mistake (default: 100)",
    )
    parser.add_argument(
        "--blunder-threshold",
        type=int,
        default=300,
        help="Centipawn drop threshold for blunder (default: 300)",
    )
    parser.add_argument(
        "--output",
        default="mistakes",
        help=(
            "Output folder path (default: mistakes). "
            "Creates <folder>/<folder_name>.csv. "
            "Run image_generation.py on the CSV to produce the chart PNG."
        ),
    )
    return parser.parse_args()


def main() -> int:
    script_started_at = time.perf_counter()
    args = parse_args()
    username = (args.username or "").strip()
    use_csv_list_mode = bool(args.user_list_csv)
    if use_csv_list_mode and username:
        raise ValueError("Use either --username or --user-list-csv, not both")
    if not use_csv_list_mode and not username:
        raise ValueError("Provide --username or --user-list-csv")
    if args.mistake_threshold <= 0 or args.blunder_threshold <= 0:
        raise ValueError("Thresholds must be positive integers")
    if args.blunder_threshold < args.mistake_threshold:
        raise ValueError("blunder-threshold must be >= mistake-threshold")
    if args.games <= 0:
        raise ValueError("--games must be > 0")
    if args.peers < 0:
        raise ValueError("--peers must be >= 0")
    if args.depth <= 0:
        raise ValueError("--depth must be > 0")
    if not args.output.strip():
        raise ValueError("--output cannot be empty")
    if Path(args.output).suffix:
        raise ValueError("--output should be a folder path, not a filename with extension")

    analysis_targets: list[str] = []
    if use_csv_list_mode:
        analysis_targets = load_usernames_from_csv(args.user_list_csv)
        if not analysis_targets:
            raise ValueError(f"No usernames found in CSV: {args.user_list_csv}")
    else:
        base_games = get_last_games(username, args.games, args.time_control)
        if not base_games:
            print(
                f"No games found for user '{username}' with time control: "
                f"{args.time_control}."
            )
            print(f"Total script runtime: {time.perf_counter() - script_started_at:.2f}s")
            return 0

        peers = select_peer_usernames(base_games, username, args.peers)
        analysis_targets = [username]
        seen_targets = {normalize_username(username)}
        for peer in peers:
            peer_norm = normalize_username(peer)
            if peer_norm and peer_norm not in seen_targets:
                analysis_targets.append(peer)
                seen_targets.add(peer_norm)

    try:
        engine = chess.engine.SimpleEngine.popen_uci(args.engine_path)
    except FileNotFoundError as exc:
        raise RuntimeError(f"Stockfish binary not found: {args.engine_path}") from exc

    try:
        rows: list[dict] = []
        analysis_times_sec: list[float] = []
        seen_game_keys: set[str] = set() if not use_csv_list_mode else set()

        for target_username in analysis_targets:
            target_games = get_last_games(target_username, args.games, args.time_control)
            unique_games = target_games if use_csv_list_mode else dedupe_games(target_games, seen_game_keys)
            target_rows, target_times = rows_from_games(
                target_username if use_csv_list_mode else username,
                target_username,
                unique_games,
                engine,
                depth=args.depth,
                mistake_cp=args.mistake_threshold,
                blunder_cp=args.blunder_threshold,
            )
            rows.extend(target_rows)
            analysis_times_sec.extend(target_times)
    finally:
        engine.quit()

    csv_path = output_csv_path(args.output)
    write_csv(csv_path, rows)
    print(f"Analyzed targets: {', '.join(analysis_targets)}")
    print(f"Wrote {len(rows)} rows to {csv_path}")
    if analysis_times_sec:
        avg_time = sum(analysis_times_sec) / len(analysis_times_sec)
        min_time = min(analysis_times_sec)
        max_time = max(analysis_times_sec)
        print(
            "Per-game analysis time (seconds): "
            f"avg={avg_time:.2f}, min={min_time:.2f}, max={max_time:.2f}"
        )
    print(f"Total script runtime: {time.perf_counter() - script_started_at:.2f}s")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)

#!/usr/bin/env python3
import argparse
import collections
import csv
import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


ARCHIVES_URL = "https://api.chess.com/pub/player/{username}/games/archives"
STATS_URL = "https://api.chess.com/pub/player/{username}/stats"
USER_AGENT = "chess-player-bucket-finder/1.0"


class HttpFetchError(RuntimeError):
    def __init__(self, status_code: int, url: str):
        super().__init__(f"HTTP {status_code} fetching {url}")
        self.status_code = status_code
        self.url = url


@dataclass
class Candidate:
    username: str
    rating: int
    games_played: int
    bucket_center: int


class ChessComClient:
    def __init__(self, sleep_seconds: float = 0.05):
        self.api_calls = 0
        self.sleep_seconds = sleep_seconds

    def fetch_json(self, url: str) -> dict:
        if self.sleep_seconds > 0:
            time.sleep(self.sleep_seconds)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        self.api_calls += 1
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise HttpFetchError(exc.code, url) from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Network error fetching {url}: {exc.reason}") from exc

    def get_last_games(self, username: str, max_games: int, time_control: str) -> list[dict]:
        archives_data = self.fetch_json(ARCHIVES_URL.format(username=urllib.parse.quote(username)))
        archives = archives_data.get("archives", [])
        if not archives:
            return []

        games: list[dict] = []
        for archive_url in reversed(archives):
            try:
                month_data = self.fetch_json(archive_url)
            except HttpFetchError as exc:
                if exc.status_code == 404:
                    continue
                raise
            for game in reversed(month_data.get("games", [])):
                if game.get("time_class") != time_control:
                    continue
                games.append(game)
                if len(games) >= max_games:
                    return games
        return games

    def get_stats(self, username: str) -> dict:
        return self.fetch_json(STATS_URL.format(username=urllib.parse.quote(username)))


def normalize_username(value: Optional[str]) -> str:
    return (value or "").strip().lower()


def parse_stats_for_time_control(stats: dict, time_control: str) -> tuple[Optional[int], int]:
    key = f"chess_{time_control}"
    mode_stats = stats.get(key, {})
    rating = mode_stats.get("last", {}).get("rating")
    if not isinstance(rating, int):
        return None, 0
    record = mode_stats.get("record", {})
    total_games = int(record.get("win", 0) or 0) + int(record.get("loss", 0) or 0) + int(record.get("draw", 0) or 0)
    return rating, total_games


def rating_to_bucket_center(rating: int, centers: list[int], tolerance: int) -> Optional[int]:
    best: Optional[int] = None
    best_gap = 10**9
    for center in centers:
        gap = abs(rating - center)
        if gap <= tolerance and gap < best_gap:
            best = center
            best_gap = gap
    return best


def default_seeds() -> list[str]:
    return [
        "AzeemGhumman3",
        "Hikaru",
        "erik",
        "magnuscarlsen",
        "gothamchess",
        "agadmator",
        "Naroditsky",
        "LevyRozman",
        "BotezLive",
        "Nakamura",
    ]


def extract_opponents(games: list[dict], for_username: str) -> list[str]:
    target = normalize_username(for_username)
    result: list[str] = []
    for g in games:
        white_u = normalize_username(g.get("white", {}).get("username"))
        black_u = normalize_username(g.get("black", {}).get("username"))
        if white_u == target and black_u:
            result.append(g.get("black", {}).get("username", ""))
        elif black_u == target and white_u:
            result.append(g.get("white", {}).get("username", ""))
    return [u for u in result if u.strip()]


def write_players_csv(path: str, players: list[Candidate]) -> None:
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["bucket_center", "username", "rating", "games_played"],
        )
        writer.writeheader()
        for p in sorted(players, key=lambda x: (x.bucket_center, x.rating, x.username.lower())):
            writer.writerow(
                {
                    "bucket_center": p.bucket_center,
                    "username": p.username,
                    "rating": p.rating,
                    "games_played": p.games_played,
                }
            )


def load_players_csv(path: str, centers: list[int]) -> list[Candidate]:
    csv_path = Path(path)
    if not csv_path.is_file():
        return []
    loaded: list[Candidate] = []
    allowed = set(centers)
    with csv_path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                bucket = int(row.get("bucket_center", ""))
                rating = int(row.get("rating", ""))
                games_played = int(row.get("games_played", ""))
            except ValueError:
                continue
            username = (row.get("username") or "").strip()
            if not username or bucket not in allowed:
                continue
            loaded.append(
                Candidate(
                    username=username,
                    rating=rating,
                    games_played=games_played,
                    bucket_center=bucket,
                )
            )
    return loaded


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Find Chess.com players by rating buckets using graph sampling."
    )
    parser.add_argument("--time-control", default="blitz", choices=["bullet", "blitz", "rapid", "daily"])
    parser.add_argument("--min-rating", type=int, default=100)
    parser.add_argument("--max-rating", type=int, default=3000)
    parser.add_argument("--bucket-step", type=int, default=100)
    parser.add_argument("--tolerance", type=int, default=10)
    parser.add_argument("--players-per-bucket", type=int, default=10)
    parser.add_argument("--min-games", type=int, default=100)
    parser.add_argument("--games-per-user-scan", type=int, default=60)
    parser.add_argument("--max-api-calls", type=int, default=6000)
    parser.add_argument("--sleep-seconds", type=float, default=0.05)
    parser.add_argument(
        "--checkpoint-every",
        type=int,
        default=100,
        help="Write partial CSV every N API calls (default: 100)",
    )
    parser.add_argument("--seed", action="append", default=[])
    parser.add_argument(
        "--resume-from",
        help=(
            "Optional existing output CSV to resume from. "
            "Previously selected players are loaded and kept."
        ),
    )
    parser.add_argument("--output", default="analysis/find-players/players.csv")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.min_rating > args.max_rating:
        raise ValueError("--min-rating must be <= --max-rating")
    if args.bucket_step <= 0:
        raise ValueError("--bucket-step must be > 0")
    if args.players_per_bucket <= 0:
        raise ValueError("--players-per-bucket must be > 0")

    centers = list(range(args.min_rating, args.max_rating + 1, args.bucket_step))
    selected: dict[int, list[Candidate]] = {c: [] for c in centers}
    selected_usernames: set[str] = set()

    resume_path = args.resume_from or args.output
    loaded_candidates = load_players_csv(resume_path, centers)
    for cand in loaded_candidates:
        norm = normalize_username(cand.username)
        if not norm or norm in selected_usernames:
            continue
        if len(selected[cand.bucket_center]) >= args.players_per_bucket:
            continue
        selected[cand.bucket_center].append(cand)
        selected_usernames.add(norm)

    seeds = args.seed[:] if args.seed else default_seeds()
    for cand in loaded_candidates:
        seeds.append(cand.username)
    queue: collections.deque[str] = collections.deque(seeds)
    seen_enqueued = {normalize_username(s) for s in seeds}
    validated_users = set()

    client = ChessComClient(sleep_seconds=args.sleep_seconds)

    while queue and client.api_calls < args.max_api_calls:
        if all(len(selected[c]) >= args.players_per_bucket for c in centers):
            break

        username = queue.popleft().strip()
        norm = normalize_username(username)
        if not norm:
            continue

        if norm not in validated_users:
            validated_users.add(norm)
            try:
                stats = client.get_stats(username)
            except HttpFetchError as exc:
                if exc.status_code in (404, 410, 429):
                    continue
                raise

            rating, total_games = parse_stats_for_time_control(stats, args.time_control)
            if rating is not None and total_games >= args.min_games:
                bucket = rating_to_bucket_center(rating, centers, args.tolerance)
                if bucket is not None and len(selected[bucket]) < args.players_per_bucket and norm not in selected_usernames:
                    selected[bucket].append(
                        Candidate(
                            username=username,
                            rating=rating,
                            games_played=total_games,
                            bucket_center=bucket,
                        )
                    )
                    selected_usernames.add(norm)

        try:
            games = client.get_last_games(username, args.games_per_user_scan, args.time_control)
        except HttpFetchError as exc:
            if exc.status_code in (404, 410, 429):
                continue
            raise
        opponents = extract_opponents(games, username)
        random.shuffle(opponents)
        for opp in opponents:
            opp_norm = normalize_username(opp)
            if not opp_norm or opp_norm in seen_enqueued:
                continue
            queue.append(opp)
            seen_enqueued.add(opp_norm)

        if args.checkpoint_every > 0 and client.api_calls % args.checkpoint_every == 0:
            players_snapshot = [p for bucket_players in selected.values() for p in bucket_players]
            write_players_csv(args.output, players_snapshot)

    players = [p for bucket_players in selected.values() for p in bucket_players]
    write_players_csv(args.output, players)

    filled = sum(1 for c in centers if len(selected[c]) >= args.players_per_bucket)
    print(f"Wrote {len(players)} players to {args.output}")
    print(f"Buckets fully filled: {filled}/{len(centers)}")
    print(f"API calls used: {client.api_calls}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

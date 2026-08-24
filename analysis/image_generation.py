#!/usr/bin/env python3
"""
Build cumulative first-mistake chart PNG from analyze_mistakes CSV output.

Usage:
  python image_generation.py --input analysis/results/run/run.csv
  python image_generation.py --input run.csv --output run.png
"""

from __future__ import annotations

import argparse
import csv
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import matplotlib.pyplot as plt


def normalize_username(value: Optional[str]) -> str:
    return (value or "").strip().lower()


def parse_csv_row_time(value: str) -> float:
    value = (value or "").strip()
    if not value:
        return 0.0
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        return 0.0


def parse_int_field(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def load_rows(csv_path: str) -> list[dict[str, str]]:
    with open(csv_path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def latest_rating_by_user(rows: list[dict[str, str]]) -> dict[str, Optional[int]]:
    """Most recent player_rating per user (normalized username), by end_time."""
    best_ts: dict[str, float] = {}
    rating_by_norm: dict[str, Optional[int]] = {}

    for row in rows:
        user = (row.get("detailed_analysis_username") or "").strip()
        if not user:
            continue
        key = normalize_username(user)
        ts = parse_csv_row_time(row.get("end_time", ""))
        rating = parse_int_field(row.get("player_rating"))
        if key not in best_ts or ts >= best_ts[key]:
            best_ts[key] = ts
            rating_by_norm[key] = rating
    return rating_by_norm


def write_cumulative_chart_from_rows(
    rows: list[dict[str, str]],
    output_path: str,
) -> str:
    if not rows:
        raise ValueError("CSV has no data rows")

    basic_username = (rows[0].get("basic_analysis_username") or "").strip()
    if not basic_username:
        raise ValueError("CSV missing basic_analysis_username")

    time_control = (rows[0].get("time_class") or "").strip() or "unknown"
    total_games = len(rows)
    target_norm = normalize_username(basic_username)
    rating_by_norm = latest_rating_by_user(rows)
    target_rating = rating_by_norm.get(target_norm)

    per_user_all_games: dict[str, int] = {}
    per_user_move_numbers: dict[str, list[int]] = {}

    for row in rows:
        detailed_user = (row.get("detailed_analysis_username") or "").strip()
        if not detailed_user:
            continue
        per_user_all_games[detailed_user] = per_user_all_games.get(detailed_user, 0) + 1
        per_user_move_numbers.setdefault(detailed_user, [])
        if (row.get("first_error_type") or "").strip() == "none":
            continue
        move_value = parse_int_field(row.get("move_number"))
        if move_value is not None:
            per_user_move_numbers[detailed_user].append(move_value)

    fig, ax = plt.subplots(figsize=(11, 7))
    has_any_curve = False
    all_move_numbers = [mv for values in per_user_move_numbers.values() for mv in values]
    max_move = max(all_move_numbers) if all_move_numbers else 1
    x_values = list(range(1, max_move + 1))

    for detailed_user in sorted(per_user_all_games.keys(), key=normalize_username):
        moves = per_user_move_numbers.get(detailed_user, [])
        user_total = per_user_all_games[detailed_user]
        if user_total <= 0:
            continue

        cumulative_percentages = [
            (sum(1 for mv in moves if mv <= x) / user_total) * 100 for x in x_values
        ]
        is_target = normalize_username(detailed_user) == target_norm
        line_color = "red" if is_target else "gray"
        line_alpha = 1.0 if is_target else 0.7
        line_width = 2.2 if is_target else 1.6

        rating = rating_by_norm.get(normalize_username(detailed_user))
        rating_text = str(rating) if rating is not None else "N/A"
        label = f"{detailed_user} ({rating_text}) (n={user_total})"

        ax.plot(
            x_values,
            cumulative_percentages,
            color=line_color,
            alpha=line_alpha,
            linewidth=line_width,
            marker="o",
            markersize=3,
            label=label,
        )
        has_any_curve = True

    if not has_any_curve:
        ax.text(
            0.5,
            0.5,
            "No mistakes/blunders found in analyzed games",
            ha="center",
            va="center",
            transform=ax.transAxes,
        )
        ax.set_xlim(0, 1)
    else:
        ax.set_xlim(1, max_move)
    ax.set_ylim(0, 100)

    rating_title = str(target_rating) if target_rating is not None else "N/A"
    ax.set_title(
        f"Cumulative first mistake move number: {basic_username} ({rating_title}) [{time_control}] "
        f"(total games: {total_games})"
    )
    ax.set_xlabel("Move number")
    ax.set_ylabel("Games with first mistake at or before this move (%)")
    ax.grid(True, linestyle="--", alpha=0.4)
    if has_any_curve:
        ax.legend(loc="upper left", fontsize=8)

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(str(out), dpi=150)
    plt.close(fig)
    return str(out)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate cumulative mistake chart from analyze_mistakes CSV.")
    parser.add_argument("--input", required=True, help="Path to CSV produced by analyze_mistakes.py")
    parser.add_argument(
        "--output",
        help="Path for PNG output (default: same directory and basename as input, .png)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    csv_path = Path(args.input)
    if not csv_path.is_file():
        raise FileNotFoundError(f"Input CSV not found: {csv_path}")

    output_png = args.output
    if not output_png:
        output_png = str(csv_path.with_suffix(".png"))

    rows = load_rows(str(csv_path))
    written = write_cumulative_chart_from_rows(rows, output_png)
    print(f"Wrote chart to {written}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

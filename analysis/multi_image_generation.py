#!/usr/bin/env python3
"""
Generate a combined cumulative chart from multiple analysis CSV files.

Each CSV contributes one line: the base username for that file
(`basic_analysis_username`), excluding peer lines.
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path
from typing import Any, Optional

import matplotlib.pyplot as plt


def normalize_username(value: Optional[str]) -> str:
    return (value or "").strip().lower()


def parse_int_field(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def load_rows(csv_path: Path) -> list[dict[str, str]]:
    with csv_path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def extract_curves_from_combined_csv(rows: list[dict[str, str]]) -> list[tuple[str, int, list[int]]]:
    """
    For a combined CSV (many users in one file), build one curve per user.
    """
    if not rows:
        raise ValueError("CSV has no rows")

    per_user_rows: dict[str, list[dict[str, str]]] = {}
    for row in rows:
        user = (row.get("detailed_analysis_username") or "").strip()
        if not user:
            continue
        per_user_rows.setdefault(user, []).append(row)

    curves: list[tuple[str, int, list[int]]] = []
    for user, user_rows in sorted(per_user_rows.items(), key=lambda x: normalize_username(x[0])):
        move_numbers: list[int] = []
        for row in user_rows:
            if (row.get("first_error_type") or "").strip() == "none":
                continue
            move_number = parse_int_field(row.get("move_number"))
            if move_number is not None:
                move_numbers.append(move_number)
        curves.append((user, len(user_rows), move_numbers))

    if not curves:
        raise ValueError("No valid user rows found in combined CSV")
    return curves


def extract_user_curves(rows: list[dict[str, str]]) -> tuple[str, dict[str, tuple[int, list[int]]]]:
    if not rows:
        raise ValueError("CSV has no rows")

    basic_username = (rows[0].get("basic_analysis_username") or "").strip()
    if not basic_username:
        raise ValueError("CSV missing basic_analysis_username")
    per_user_rows: dict[str, list[dict[str, str]]] = {}
    for row in rows:
        detailed_user = (row.get("detailed_analysis_username") or "").strip()
        if not detailed_user:
            continue
        per_user_rows.setdefault(detailed_user, []).append(row)

    base_norm = normalize_username(basic_username)
    if not any(normalize_username(u) == base_norm for u in per_user_rows.keys()):
        raise ValueError(f"No rows found for base username '{basic_username}'")

    user_curves: dict[str, tuple[int, list[int]]] = {}
    for username, user_rows in per_user_rows.items():
        move_numbers: list[int] = []
        for row in user_rows:
            if (row.get("first_error_type") or "").strip() == "none":
                continue
            move_number = parse_int_field(row.get("move_number"))
            if move_number is not None:
                move_numbers.append(move_number)
        user_curves[username] = (len(user_rows), move_numbers)

    return basic_username, user_curves


def write_multi_chart(input_csvs: list[Path], output_png: Path, include_peers: bool) -> Path:
    file_curves: list[tuple[str, dict[str, tuple[int, list[int]]]]] = []
    for p in input_csvs:
        rows = load_rows(p)
        file_curves.append(extract_user_curves(rows))

    all_moves = [
        mv
        for _, user_curves in file_curves
        for _, moves in user_curves.values()
        for mv in moves
    ]
    max_move = max(all_moves) if all_moves else 1
    x_values = list(range(1, max_move + 1))

    fig, ax = plt.subplots(figsize=(11, 7))
    colors = list(plt.cm.tab10.colors) + list(plt.cm.tab20.colors)

    for idx, (base_username, user_curves) in enumerate(file_curves):
        base_norm = normalize_username(base_username)
        color = colors[idx % len(colors)]

        for detailed_user, (total_games, moves) in sorted(user_curves.items(), key=lambda x: normalize_username(x[0])):
            if total_games <= 0:
                continue
            is_base = normalize_username(detailed_user) == base_norm
            if not include_peers and not is_base:
                continue
            y_values = [(sum(1 for mv in moves if mv <= x) / total_games) * 100 for x in x_values]
            ax.plot(
                x_values,
                y_values,
                color=color,
                linewidth=2.8 if is_base else 1.4,
                alpha=1.0 if is_base else 0.25,
                marker="o",
                markersize=3 if is_base else 2,
                label=base_username if is_base else "_nolegend_",
            )

    ax.set_xlim(1, max_move)
    ax.set_ylim(0, 100)
    ax.set_title("Cumulative First Mistake Comparison")
    ax.set_xlabel("Move number")
    ax.set_ylabel("Games with first mistake at or before this move (%)")
    ax.grid(True, linestyle="--", alpha=0.4)
    ax.legend(loc="upper left", fontsize=9)

    output_png.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(str(output_png), dpi=150)
    plt.close(fig)
    return output_png


def write_combined_csv_chart(combined_csv: Path, output_png: Path) -> Path:
    rows = load_rows(combined_csv)
    curves = extract_curves_from_combined_csv(rows)

    all_moves = [mv for _, _, moves in curves for mv in moves]
    max_move = max(all_moves) if all_moves else 1
    x_values = list(range(1, max_move + 1))

    fig, ax = plt.subplots(figsize=(12, 7))
    colors = list(plt.cm.tab20.colors) + list(plt.cm.tab20b.colors) + list(plt.cm.tab20c.colors)

    for idx, (username, total_games, moves) in enumerate(curves):
        if total_games <= 0:
            continue
        y_values = [(sum(1 for mv in moves if mv <= x) / total_games) * 100 for x in x_values]
        ax.plot(
            x_values,
            y_values,
            color=colors[idx % len(colors)],
            linewidth=2.0,
            alpha=0.9,
            label=username,
        )

    ax.set_xlim(1, max_move)
    ax.set_ylim(0, 100)
    ax.set_title(f"Cumulative First Mistake Comparison ({len(curves)} users)")
    ax.set_xlabel("Move number")
    ax.set_ylabel("Games with first mistake at or before this move (%)")
    ax.grid(True, linestyle="--", alpha=0.4)
    ax.legend(loc="upper left", fontsize=7, ncol=2)

    output_png.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(str(output_png), dpi=150)
    plt.close(fig)
    return output_png


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate one comparison PNG from multiple analyze_mistakes CSV files."
    )
    parser.add_argument(
        "--inputs",
        nargs="+",
        help="One or more CSV files generated by analyze_mistakes.py",
    )
    parser.add_argument(
        "--combined-csv",
        help=(
            "Path to a single combined CSV containing many users "
            "(for example output from analyze_mistakes.py --user-list-csv)."
        ),
    )
    parser.add_argument(
        "--output",
        default="analysis/results/comparison/comparison.png",
        help="Output PNG path (default: analysis/results/comparison/comparison.png)",
    )
    parser.add_argument(
        "--include-peers",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Whether to draw peer lines for each file (default: true). Use --no-include-peers to hide peers.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if bool(args.inputs) == bool(args.combined_csv):
        raise ValueError("Provide exactly one of --inputs or --combined-csv")

    if args.combined_csv:
        combined_path = Path(args.combined_csv)
        if not combined_path.is_file():
            raise FileNotFoundError(f"Combined CSV not found: {combined_path}")
        output = write_combined_csv_chart(combined_path, Path(args.output))
    else:
        input_paths = [Path(p) for p in args.inputs]
        missing = [str(p) for p in input_paths if not p.is_file()]
        if missing:
            raise FileNotFoundError(f"Missing CSV files: {', '.join(missing)}")
        output = write_multi_chart(input_paths, Path(args.output), include_peers=args.include_peers)
    print(f"Wrote chart to {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

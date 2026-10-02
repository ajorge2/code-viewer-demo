#!/usr/bin/env python3
"""Plot auditable diagnostics for prepared message-to-code records."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np


COLORS = {"python": "#377eb8", "javascript": "#ff9f1c"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def save(fig: plt.Figure, path: Path) -> None:
    fig.tight_layout()
    fig.savefig(path, format="svg", bbox_inches="tight")
    fig.savefig(path.with_suffix(".png"), format="png", dpi=180, bbox_inches="tight")
    plt.close(fig)


def plot_preparation_outcomes(rows: list[dict], output: Path) -> None:
    languages = ["python", "javascript"]
    success = [sum(row["language"] == language and not row.get("preparation_error") for row in rows)
               for language in languages]
    errors = [sum(row["language"] == language and bool(row.get("preparation_error")) for row in rows)
              for language in languages]
    x = np.arange(len(languages))
    fig, ax = plt.subplots(figsize=(7.2, 4.2))
    ax.bar(x, success, color=[COLORS[language] for language in languages], label="Prepared")
    ax.bar(x, errors, bottom=success, color="#c7c7c7", label="Parse error")
    for index, (ok, failed) in enumerate(zip(success, errors, strict=True)):
        ax.text(index, ok / 2, str(ok), ha="center", va="center", color="white", fontweight="bold")
        if failed:
            ax.text(index, ok + failed / 2, str(failed), ha="center", va="center")
    ax.set_xticks(x, ["Python", "JavaScript"])
    ax.set_ylabel("File-level diff records")
    ax.set_title("AST candidate preparation outcomes")
    ax.legend(frameon=False)
    ax.spines[["top", "right"]].set_visible(False)
    save(fig, output / "01-preparation-outcomes.svg")


def plot_candidate_distribution(rows: list[dict], output: Path) -> None:
    fig, ax = plt.subplots(figsize=(7.2, 4.4))
    for language in ["python", "javascript"]:
        values = sorted(len(row.get("candidates", [])) for row in rows
                        if row["language"] == language and not row.get("preparation_error"))
        cumulative = np.arange(1, len(values) + 1) / len(values)
        ax.step(values, cumulative, where="post", linewidth=2, color=COLORS[language],
                label=language.title())
    ax.set_xlabel("AST candidates in one record")
    ax.set_ylabel("Cumulative share of prepared records")
    ax.set_title("Candidate-set size distribution")
    ax.set_xlim(left=0)
    ax.set_ylim(0, 1.01)
    ax.grid(axis="y", alpha=0.25)
    ax.legend(frameon=False)
    ax.spines[["top", "right"]].set_visible(False)
    save(fig, output / "02-candidate-set-size.svg")


def plot_candidate_roles(rows: list[dict], output: Path) -> None:
    role_counts: dict[str, Counter] = defaultdict(Counter)
    for row in rows:
        for candidate in row.get("candidates", []):
            for role in candidate.get("roles", []):
                role_counts[row["language"]][role] += 1
    roles = [
        "direct_edit", "single_edit_ancestor", "overall_lca", "subset_lca", "path",
    ]
    labels = ["Direct edit", "Single-edit ancestor", "Overall LCA", "Subset LCA", "Path node"]
    x = np.arange(len(roles))
    width = 0.38
    fig, ax = plt.subplots(figsize=(8.6, 4.6))
    for offset, language in zip([-width / 2, width / 2], ["python", "javascript"], strict=True):
        values = [role_counts[language][role] for role in roles]
        ax.bar(x + offset, values, width, color=COLORS[language], label=language.title())
    ax.set_xticks(x, labels, rotation=18, ha="right")
    ax.set_ylabel("Candidate-role assignments")
    ax.set_title("How AST candidates were generated")
    ax.grid(axis="y", alpha=0.25)
    ax.legend(frameon=False)
    ax.spines[["top", "right"]].set_visible(False)
    save(fig, output / "03-candidate-roles.svg")


def main() -> None:
    args = parse_args()
    rows = read_jsonl(args.input)
    args.output.mkdir(parents=True, exist_ok=True)
    plot_preparation_outcomes(rows, args.output)
    plot_candidate_distribution(rows, args.output)
    plot_candidate_roles(rows, args.output)
    print(f"Wrote 3 figures to {args.output}")


if __name__ == "__main__":
    main()

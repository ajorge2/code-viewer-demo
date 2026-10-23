#!/usr/bin/env python3
"""Generate SVG figures for the clean semantic-first function pilot."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def load_plot_helpers(path: Path):
    spec = importlib.util.spec_from_file_location("intent_plot_helpers", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load plot helpers from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def plot_funnel(helpers, descriptions: dict, clusters: dict, terms: dict, output: Path) -> None:
    stages = [
        ("Function units", descriptions["functions"], helpers.MEDIUM_CONFIDENCE),
        ("Described", descriptions["functions"] - descriptions["abstentions"], helpers.MEDIUM_CONFIDENCE),
        ("Density-clustered", sum(cluster["support"] for cluster in clusters["clusters"]), helpers.INTERSECTION),
        ("Coherence-retained", sum(term["support"] for term in terms["candidates"]), helpers.HIGH_CONFIDENCE),
        ("Validated terms", terms["registered_count"], helpers.TOO_MANY),
    ]
    maximum = max(value for _name, value, _color in stages)
    svg = helpers.Svg(
        "Semantic-first pilot funnel",
        "Function behavior alone determines clustering; structural verification has not begun",
        height=780,
    )
    for index, (name, value, color) in enumerate(stages):
        y = 155 + index * 92
        svg.text(70, y + 28, name, size=18)
        svg.rect(320, y, 850, 46, "#f2f4f7", rx=7)
        if value:
            svg.rect(320, y, 850 * value / maximum, 46, color, rx=7)
        svg.text(1205, y + 31, value, weight=700, size=21, fill=color)
    svg.rect(70, 645, 1260, 72, "#f8fafc", rx=10, stroke=helpers.GRID)
    svg.text(95, 678, "160 repository families · 80 Python + 80 JavaScript · 124 explicit residuals after coherence review", size=16)
    svg.text(95, 703, "Ten semantic hypotheses remain low-confidence; none is registered or structurally tested.", cls="note")
    svg.finish(output)


def plot_candidate_confidence(helpers, terms: dict, output: Path) -> None:
    candidates = sorted(terms["candidates"], key=lambda item: (-item["support"], item["name"]))
    height = 200 + len(candidates) * 70
    svg = helpers.Svg(
        "Semantic term candidates remain provisional",
        "Support and cumulative definition-to-member fit after the semantic coherence gate",
        height=height,
    )
    max_support = max(term["support"] for term in candidates)
    for index, term in enumerate(candidates):
        y = 145 + index * 70
        label = term["name"]
        support = term["support"]
        fit = term["semantic_confidence"]["mean_label_fit"]
        svg.text(70, y + 22, label, size=16)
        svg.rect(430, y, 360, 30, "#f2f4f7", rx=6)
        svg.rect(430, y, 360 * support / max_support, 30, helpers.LOW_CONFIDENCE, rx=6)
        svg.text(810, y + 22, f"{support} repos", size=15, weight=700, fill=helpers.LOW_CONFIDENCE)
        svg.rect(930, y, 260, 30, "#f2f4f7", rx=6)
        svg.rect(930, y, 260 * fit, 30, helpers.INTERSECTION, rx=6)
        svg.text(1210, y + 22, f"fit {fit:.3f}", size=15, weight=700, fill=helpers.INTERSECTION)
    svg.text(70, height - 42, "Every member preferred its own candidate label over all nine alternatives, but evidence is too small for promotion.", cls="note")
    svg.finish(output)


def main() -> None:
    args = parse_args()
    here = Path(__file__).resolve().parent
    helpers = load_plot_helpers(here / "plot-pilot.py")
    descriptions = json.loads((args.input / "semantic-descriptions-summary.json").read_text(encoding="utf-8"))
    clusters = json.loads((args.input / "semantic-clusters.json").read_text(encoding="utf-8"))
    terms = json.loads((args.input / "scored-semantic-terms.json").read_text(encoding="utf-8"))
    args.output.mkdir(parents=True, exist_ok=True)
    plot_funnel(helpers, descriptions, clusters, terms, args.output / "01-semantic-pilot-funnel.svg")
    plot_candidate_confidence(helpers, terms, args.output / "02-semantic-candidate-confidence.svg")
    print(f"Wrote 2 figures to {args.output}")


if __name__ == "__main__":
    main()

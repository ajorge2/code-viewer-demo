#!/usr/bin/env python3
"""Generate dependency-free SVG figures for the Intent Algebra pilot report.

The script deliberately reads the persisted pilot artifacts rather than repeating
any filtering or AST analysis.  This keeps the figures reproducible and makes the
distinction between full-corpus counts and sample estimates explicit.
"""

from __future__ import annotations

import argparse
import html
import json
import math
from collections import Counter
from pathlib import Path


WIDTH = 1400
HEIGHT = 820
BG = "#ffffff"
INK = "#172033"
MUTED = "#667085"
GRID = "#d7dde7"
PYTHON = "#2563eb"
JAVASCRIPT = "#d97706"
ELIGIBLE = "#138a72"
TOO_MANY = "#d95d39"
REMOVAL_HEAVY = "#b7791f"
ERROR = "#70798c"
INTERSECTION = "#7c3aed"
PALE = "#e8edf5"
HIGH_CONFIDENCE = "#138a72"
MEDIUM_CONFIDENCE = "#2563eb"
LOW_CONFIDENCE = "#d97706"
ABSTAIN = "#70798c"


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


class Svg:
    def __init__(self, title: str, subtitle: str, *, height: int = HEIGHT):
        self.parts = [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{height}" '
            f'viewBox="0 0 {WIDTH} {height}" role="img" aria-labelledby="title desc">',
            f"<title id=\"title\">{esc(title)}</title>",
            f"<desc id=\"desc\">{esc(subtitle)}</desc>",
            f'<rect width="{WIDTH}" height="{height}" fill="{BG}"/>',
            '<style>text{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}'
            '.title{font-size:31px;font-weight:700;fill:#172033}.subtitle{font-size:17px;fill:#667085}'
            '.axis{font-size:15px;fill:#667085}.label{font-size:18px;fill:#172033}'
            '.value{font-size:18px;font-weight:700}.note{font-size:14px;fill:#667085}</style>',
        ]
        self.text(70, 65, title, cls="title")
        self.text(70, 98, subtitle, cls="subtitle")

    def text(
        self,
        x: float,
        y: float,
        value: object,
        *,
        cls: str = "label",
        anchor: str = "start",
        fill: str | None = None,
        weight: int | None = None,
        size: int | None = None,
    ) -> None:
        attrs = [f'x="{x:.1f}"', f'y="{y:.1f}"', f'text-anchor="{anchor}"', f'class="{cls}"']
        styles = []
        if fill:
            styles.append(f"fill:{fill}")
        if weight:
            styles.append(f"font-weight:{weight}")
        if size:
            styles.append(f"font-size:{size}px")
        if styles:
            attrs.append(f'style="{';'.join(styles)}"')
        self.parts.append(f"<text {' '.join(attrs)}>{esc(value)}</text>")

    def rect(
        self,
        x: float,
        y: float,
        w: float,
        h: float,
        fill: str,
        *,
        rx: float = 0,
        stroke: str | None = None,
        stroke_width: float = 1,
    ) -> None:
        attrs = f'x="{x:.1f}" y="{y:.1f}" width="{max(0, w):.1f}" height="{h:.1f}" fill="{fill}" rx="{rx:.1f}"'
        if stroke:
            attrs += f' stroke="{stroke}" stroke-width="{stroke_width}"'
        self.parts.append(f"<rect {attrs}/>")

    def line(
        self,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        *,
        stroke: str = GRID,
        width: float = 1,
        dash: str | None = None,
    ) -> None:
        extra = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(
            f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="{stroke}" stroke-width="{width}"{extra}/>'
        )

    def circle(
        self,
        x: float,
        y: float,
        radius: float,
        fill: str,
        *,
        stroke: str = "#ffffff",
        stroke_width: float = 1.5,
    ) -> None:
        self.parts.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{radius:.1f}" fill="{fill}" '
            f'stroke="{stroke}" stroke-width="{stroke_width}"/>'
        )

    def finish(self, path: Path) -> None:
        self.parts.append("</svg>")
        path.write_text("\n".join(self.parts) + "\n", encoding="utf-8")


def language_name(key: str) -> str:
    return {"python": "Python", "javascript": "JavaScript"}.get(key, key.title())


def plot_filter_funnel(summary: dict, output: Path) -> None:
    svg = Svg(
        "Corpus screening funnel by language",
        "Full-corpus row counts before and after deterministic, non-AST noise filters",
    )
    left, right = 275, 1280
    width = right - left
    max_raw = max(values["raw"] for values in summary["by_language"].values())

    svg.text(70, 150, "Full corpus (not a sample)", fill=INK, weight=700, size=18)
    for i, language in enumerate(("python", "javascript")):
        values = summary["by_language"][language]
        raw = values["raw"]
        kept = values["cheap_eligible"]
        color = PYTHON if language == "python" else JAVASCRIPT
        y = 225 + i * 230
        raw_w = width * raw / max_raw
        kept_w = width * kept / max_raw
        svg.text(left - 24, y + 34, language_name(language), anchor="end", weight=700, size=20)
        svg.rect(left, y, raw_w, 65, PALE, rx=7)
        svg.rect(left, y, kept_w, 65, color, rx=7)
        svg.text(left + 15, y + 41, f"{kept:,} retained", fill="#ffffff", weight=700, size=18)
        svg.text(left + raw_w, y - 12, f"{raw:,} raw rows", anchor="end", fill=INK, weight=700, size=17)
        svg.text(
            left + raw_w,
            y + 93,
            f"{kept / raw:.1%} retained",
            cls="axis",
            anchor="end",
        )
        svg.text(left, y + 93, "Rows surviving non-AST noise filters", cls="axis")

    total = summary["totals"]
    excluded = total["raw"] - total["cheap_eligible"]
    svg.rect(70, 670, 1260, 85, "#f7f9fc", rx=10, stroke=GRID)
    svg.text(95, 705, f"Combined: {total['cheap_eligible']:,} / {total['raw']:,} rows retained ({total['cheap_eligible']/total['raw']:.1%})", weight=700)
    svg.text(95, 735, f"{excluded:,} rows excluded. Reason totals are corpus-wide; the artifact does not break them down by language.", cls="note")
    svg.finish(output)


def plot_ast_outcomes(summary: dict, output: Path) -> None:
    parameters = summary["parameters"]
    gate_enabled = parameters.get("addition_dominant_required", False)
    if gate_enabled:
        title = "Atomicity and addition-dominance outcomes"
        subtitle = (
            f"Retain 1–{parameters['max_components']} components, "
            f"≥{parameters['min_added_nodes']} added AST nodes, and "
            f"removed/added ≤{parameters['max_removal_to_addition_ratio']}"
        )
    else:
        title = "AST eligibility outcomes by language"
        subtitle = f"Retain changes with 1–{parameters['max_components']} observed-file components"
    svg = Svg(title, subtitle)
    left, right = 285, 1290
    width = right - left
    categories = (
        [
            ("ast_eligible", "Addition-dominant", ELIGIBLE),
            ("not_addition_dominant", "Removal gate rejected", REMOVAL_HEAVY),
            ("too_many_components", f">{parameters['max_components']} components", TOO_MANY),
            ("errors", "Parse/tool error", ERROR),
        ]
        if gate_enabled
        else [
            ("ast_eligible", f"1–{parameters['max_components']} components", ELIGIBLE),
            ("too_many_components", f">{parameters['max_components']} components", TOO_MANY),
            ("errors", "Parse/tool error", ERROR),
        ]
    )

    for i, language in enumerate(("python", "javascript")):
        values = summary["by_language"][language]
        sampled = values["sampled"]
        y = 220 + i * 185
        svg.text(left - 25, y + 41, language_name(language), anchor="end", weight=700, size=20)
        cursor = left
        for key, _label, color in categories:
            value = values[key]
            segment = width * value / sampled
            svg.rect(cursor, y, segment, 72, color, rx=0)
            if segment >= 55:
                svg.text(cursor + segment / 2, y + 45, f"{value} ({value/sampled:.0%})", anchor="middle", fill="#ffffff", weight=700, size=16)
            cursor += segment

    legend_x = left
    for key, label, color in categories:
        svg.rect(legend_x, 590, 22, 22, color, rx=3)
        svg.text(legend_x + 32, 608, label, size=16)
        legend_x += 260

    total = summary["totals"]
    svg.rect(70, 675, 1260, 80, "#f7f9fc", rx=10, stroke=GRID)
    if gate_enabled:
        svg.text(95, 710, f"Atomic changes: {total['ast_atomic']} / {total['sampled']}; addition-dominant changes: {total['ast_eligible']} / {total['sampled']} ({total['ast_eligible']/total['sampled']:.1%}).", weight=700)
        svg.text(95, 739, f"The removal gate retains {total['ast_eligible']/total['ast_atomic']:.1%} of atomic changes. Descriptive pilot estimate only.", cls="note")
    else:
        svg.text(95, 710, f"Observed eligibility: {total['ast_eligible']} / {total['sampled']} sampled changes ({total['ast_eligible']/total['sampled']:.1%})", weight=700)
        svg.text(95, 739, "Descriptive pilot estimate only—no confidence interval or corpus-wide significance claim.", cls="note")
    svg.finish(output)


def component_bin(value: int | None) -> str:
    if value is None:
        return "Error"
    if value <= 5:
        return str(value)
    if value <= 10:
        return "6–10"
    return "11+"


def plot_component_distribution(rows: list[dict], output: Path) -> None:
    svg = Svg(
        "AST component-count distribution",
        "Deterministic pilot sample; all 200 sampled changes, including ineligible changes and parse errors",
    )
    bins = ["1", "2", "3", "4", "5", "6–10", "11+", "Error"]
    counts = {
        language: Counter(component_bin(row.get("component_count")) for row in rows if row["language"] == language)
        for language in ("python", "javascript")
    }
    max_value = max(counts[language][bucket] for language in counts for bucket in bins)
    left, right, top, bottom = 115, 1320, 175, 665
    chart_h = bottom - top
    group_w = (right - left) / len(bins)
    bar_w = 45

    grid_max = int(math.ceil(max_value / 10) * 10)
    for tick in range(0, grid_max + 1, 10):
        y = bottom - chart_h * tick / grid_max
        svg.line(left, y, right, y)
        svg.text(left - 15, y + 5, tick, cls="axis", anchor="end")
    svg.text(left, top - 18, "Number of sampled changes", cls="axis")

    for i, bucket in enumerate(bins):
        center = left + group_w * (i + 0.5)
        for offset, (language, color) in enumerate((("python", PYTHON), ("javascript", JAVASCRIPT))):
            value = counts[language][bucket]
            h = chart_h * value / grid_max
            x = center - bar_w - 5 + offset * (bar_w + 10)
            svg.rect(x, bottom - h, bar_w, h, color, rx=4)
            if value:
                svg.text(x + bar_w / 2, bottom - h - 10, value, anchor="middle", weight=700, size=15)
        svg.text(center, bottom + 32, bucket, cls="axis", anchor="middle")

    boundary = left + group_w * 3
    svg.line(boundary, top, boundary, bottom + 50, stroke=TOO_MANY, width=2, dash="8 7")
    svg.text(boundary - 10, top - 14, "≤3-component inclusion boundary", anchor="end", fill=TOO_MANY, weight=700, size=15)

    svg.rect(965, 125, 20, 20, PYTHON, rx=3)
    svg.text(995, 142, "Python", size=15)
    svg.rect(1085, 125, 20, 20, JAVASCRIPT, rx=3)
    svg.text(1115, 142, "JavaScript", size=15)
    svg.text((left + right) / 2, 737, "Connected AST edit components per observed file", cls="axis", anchor="middle")
    svg.text(70, 785, "Counts above 5 are grouped to keep the long tail readable; errors have no component count.", cls="note")
    svg.finish(output)


def recurrence_bin(support: int) -> str:
    return "5+" if support >= 5 else str(support)


def plot_signature_recurrence(signatures: list[dict], summary: dict, output: Path) -> None:
    svg = Svg(
        "Structural-signature recurrence in eligible pilot changes",
        f"{len(signatures)} unique signatures across {summary['totals']['ast_eligible']} eligible sample changes; support is within this pilot only",
    )
    bins = ["1", "2", "3", "4", "5+"]
    sig_counts = Counter(recurrence_bin(item["support"]) for item in signatures)
    change_counts = Counter()
    for item in signatures:
        change_counts[recurrence_bin(item["support"])] += item["support"]

    left, right = 180, 1240
    max_count = max(sig_counts.values())
    # A square-root scale preserves the singleton/recurrent contrast without
    # making low-frequency categories disappear completely.
    max_scaled = math.sqrt(max_count)
    for i, bucket in enumerate(bins):
        y = 200 + i * 92
        value = sig_counts[bucket]
        bar_w = (right - left) * math.sqrt(value) / max_scaled if value else 0
        svg.text(left - 28, y + 29, f"Support {bucket}", anchor="end", weight=700, size=17)
        svg.rect(left, y, bar_w, 48, ELIGIBLE, rx=5)
        svg.text(left + bar_w + 14, y + 31, f"{value} signature{'s' if value != 1 else ''}", weight=700, size=17)
        svg.text(left + bar_w + 14, y + 53, f"{change_counts[bucket]} change{'s' if change_counts[bucket] != 1 else ''}", cls="note")

    singleton = sig_counts["1"]
    recurrent = len(signatures) - singleton
    recurrent_changes = sum(item["support"] for item in signatures if item["support"] > 1)
    eligible = summary["totals"]["ast_eligible"]
    svg.rect(70, 685, 1260, 85, "#f7f9fc", rx=10, stroke=GRID)
    svg.text(95, 719, f"{singleton} / {len(signatures)} signatures ({singleton/len(signatures):.1%}) appeared once; {recurrent} recurred.", weight=700)
    svg.text(95, 748, f"Recurrent signatures cover {recurrent_changes} / {eligible} eligible changes ({recurrent_changes/eligible:.1%}). No population-level recurrence is inferred.", cls="note")
    svg.text(1240, 650, "Bar length uses a square-root scale", cls="note", anchor="end")
    svg.finish(output)


def plot_expansion_candidates(expansion: dict, output: Path) -> None:
    candidates = expansion["composites"]
    svg = Svg(
        "Within-component expansion: recurrence versus complexity",
        "Exact-host TED clusters after structure-plus-host deduplication; multi-base contexts are lattice intersections",
    )
    left, right, top, bottom = 125, 1300, 165, 690
    max_nodes = max(candidate["maximum_context_nodes"] for candidate in candidates)
    max_support = max(candidate["commit_support"] for candidate in candidates)
    x_ceiling = int(math.ceil(max_nodes / 5) * 5)
    y_floor = 5
    y_ceiling = 200

    def x_position(value: int) -> float:
        return left + (right - left) * value / x_ceiling

    def y_position(value: int) -> float:
        return bottom - (bottom - top) * (
            math.log(value) - math.log(y_floor)
        ) / (math.log(y_ceiling) - math.log(y_floor))

    for tick in range(0, x_ceiling + 1, 5):
        x = x_position(tick)
        svg.line(x, top, x, bottom)
        svg.text(x, bottom + 29, tick, cls="axis", anchor="middle")
    for tick in (5, 10, 20, 50, 100, 200):
        y = y_position(tick)
        svg.line(left, y, right, y)
        svg.text(left - 15, y + 5, tick, cls="axis", anchor="end")

    for candidate in sorted(candidates, key=lambda item: item["is_cross_anchor_intersection"]):
        color = INTERSECTION if candidate["is_cross_anchor_intersection"] else ELIGIBLE
        radius = 5 + min(len(candidate["base_ids"]), 5)
        svg.circle(
            x_position(candidate["maximum_context_nodes"]),
            y_position(candidate["commit_support"]),
            radius,
            color,
        )

    punctuation = [candidate for candidate in candidates if candidate["commit_support"] >= 100]
    for index, candidate in enumerate(punctuation):
        x = x_position(candidate["maximum_context_nodes"])
        y = y_position(candidate["commit_support"])
        svg.text(x + 12, y - 9 - index * 2, f"comma-only ({candidate['commit_support']})", size=14, weight=700)

    import_intersections = [
        candidate for candidate in candidates
        if candidate["is_cross_anchor_intersection"]
        and "import_from_statement" in candidate["coedit_signature"]
    ]
    if import_intersections:
        candidate = max(import_intersections, key=lambda item: item["commit_support"])
        x = x_position(candidate["maximum_context_nodes"])
        y = y_position(candidate["commit_support"])
        svg.text(x + 12, y - 10, f"from-import intersection ({candidate['commit_support']})", size=14, weight=700, fill=INTERSECTION)

    svg.text((left + right) / 2, 756, "Maximum abstract nodes in candidate context", cls="axis", anchor="middle")
    svg.text(left, 139, "Commit support (log scale)", cls="axis")
    svg.circle(910, 126, 7, ELIGIBLE)
    svg.text(926, 132, "Single base anchor", size=15)
    svg.circle(1110, 126, 7, INTERSECTION)
    svg.text(1126, 132, "Cross-anchor intersection", size=15)
    intersections = sum(candidate["is_cross_anchor_intersection"] for candidate in candidates)
    svg.text(
        70,
        798,
        f"{len(candidates)} unique candidates; {intersections} intersections. The only candidates above 100 commits are punctuation-only and are not semantic primitives.",
        cls="note",
    )
    svg.finish(output)


def compact_label(value: str, maximum: int = 34) -> str:
    return value if len(value) <= maximum else value[: maximum - 1] + "…"


def plot_semantic_refinement(refinement: dict, output: Path) -> None:
    nodes = {node["node_id"]: node for node in refinement["nodes"]}
    roots = [nodes[root_id] for root_id in refinement["roots"] if nodes[root_id]["contains"]]
    roots.sort(key=lambda node: -node["support"])
    shown = roots[:3]
    panel_heights = [max(160, len(root["contains"]) * 42 + 45) for root in shown]
    height = 155 + sum(panel_heights) + 55
    svg = Svg(
        "Downward semantic refinement",
        "The three largest accepted roots; child meanings are discovered within each parent, while structural rules remain evidence",
        height=height,
    )
    y_cursor = 145
    for panel_index, (root, panel_height) in enumerate(zip(shown, panel_heights, strict=True)):
        color = (PYTHON, JAVASCRIPT, INTERSECTION)[panel_index % 3]
        children = [nodes[child_id] for child_id in root["contains"]]
        first_child_y = y_cursor + 27
        last_child_y = first_child_y + (len(children) - 1) * 42
        root_y = (first_child_y + last_child_y) / 2
        svg.rect(70, root_y - 25, 330, 50, PALE, rx=7, stroke=GRID)
        svg.rect(70, root_y - 25, 8, 50, color, rx=3)
        svg.text(90, root_y - 3, compact_label(root["label"]), weight=700, size=16)
        svg.text(90, root_y + 17, f"{root['support']} changes", cls="note")
        split_x = 455
        svg.line(400, root_y, split_x, root_y, stroke=GRID, width=2)
        svg.line(split_x, first_child_y, split_x, last_child_y, stroke=GRID, width=2)
        for child_index, child in enumerate(children):
            child_y = first_child_y + child_index * 42
            svg.line(split_x, child_y, 500, child_y, stroke=GRID, width=2)
            svg.rect(500, child_y - 16, 385, 32, "#f7f9fc", rx=5, stroke=GRID)
            svg.text(515, child_y + 5, f"{compact_label(child['label'], 31)} · {child['support']}", size=14)
            grandchildren = [nodes[child_id] for child_id in child.get("contains", [])]
            if grandchildren:
                labels = "; ".join(
                    f"{compact_label(grandchild['label'], 20)} ({grandchild['support']})"
                    for grandchild in grandchildren
                )
                svg.line(885, child_y, 925, child_y, stroke=GRID, width=2)
                svg.text(940, child_y + 5, compact_label(labels, 52), cls="note")
        if panel_index < len(shown) - 1:
            svg.line(70, y_cursor + panel_height - 10, 1330, y_cursor + panel_height - 10)
        y_cursor += panel_height
    svg.text(
        70,
        height - 25,
        f"{refinement['accepted_split_count']} accepted splits overall; maximum depth {refinement['maximum_observed_depth']}. Labels are provisional noun summaries.",
        cls="note",
    )
    svg.finish(output)


def plot_meaning_confidence(grounding: dict, output: Path) -> None:
    nodes = grounding["nodes"]
    svg = Svg(
        "Centroid-aware semantic confidence",
        "Each point is a grounded semantic node; confidence combines member consensus, winner margin, and bootstrap stability",
    )
    left, right, top, bottom = 135, 1295, 175, 680
    x_max, y_max = 1.0, 0.14

    def x_position(value: float) -> float:
        return left + (right - left) * value / x_max

    def y_position(value: float) -> float:
        return bottom - (bottom - top) * min(value, y_max) / y_max

    for tick in (0, 0.25, 0.5, 0.75, 1.0):
        x = x_position(tick)
        svg.line(x, top, x, bottom)
        svg.text(x, bottom + 29, f"{tick:.0%}", cls="axis", anchor="middle")
    for tick in (0, 0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.14):
        y = y_position(tick)
        svg.line(left, y, right, y)
        svg.text(left - 15, y + 5, f"{tick:.2f}", cls="axis", anchor="end")

    # These are visible policy gates, not learned decision boundaries.
    for threshold in (0.55, 0.75):
        svg.line(x_position(threshold), top, x_position(threshold), bottom, stroke=MUTED, width=1.5, dash="7 6")
    svg.line(left, y_position(0.02), right, y_position(0.02), stroke=MUTED, width=1.5, dash="7 6")

    colors = {
        "high": HIGH_CONFIDENCE,
        "medium": MEDIUM_CONFIDENCE,
        "low": LOW_CONFIDENCE,
        "abstain": ABSTAIN,
    }
    annotate = {
        "EMBED_CONCEPT_0003",
        "EMBED_CONCEPT_0002",
        "EMBED_CONCEPT_0016",
        "EMBED_CONCEPT_0001.S02",
        "EMBED_CONCEPT_0021",
    }
    for node in sorted(nodes, key=lambda item: item["support"], reverse=True):
        confidence = node["confidence"]
        level = confidence["level"]
        x = x_position(confidence["member_vote_share"])
        y = y_position(confidence["winner_margin"])
        radius = 5 + 2.2 * math.sqrt(node["support"])
        svg.circle(x, y, radius, colors[level], stroke="#ffffff", stroke_width=2)
        if node["node_id"] in annotate:
            name = node.get("chosen_meaning", {}).get("name") or node["node_id"]
            label = f"{compact_label(name, 30)} · n={node['support']}"
            x_offset = -12 if x > 1050 else 12
            anchor = "end" if x > 1050 else "start"
            y_offset = -13 if node["node_id"] != "EMBED_CONCEPT_0002" else 27
            svg.text(x + x_offset, y + y_offset, label, anchor=anchor, size=13, weight=700, fill=colors[level])

    svg.text((left + right) / 2, 752, "Member vote share for the selected meaning", cls="axis", anchor="middle")
    svg.text(left, 143, "Winner margin over the runner-up", cls="axis")
    legend_x = 720
    counts = grounding["confidence_level_counts"]
    for level in ("high", "medium", "low", "abstain"):
        svg.circle(legend_x, 128, 7, colors[level])
        svg.text(legend_x + 15, 134, f"{level.title()} ({counts.get(level, 0)})", size=14)
        legend_x += 145
    svg.text(
        70,
        798,
        "Circle area increases with support. Abstention can override a geometrically strong winner when sampled meanings contradict one another; scores are heuristic, not calibrated probabilities.",
        cls="note",
    )
    svg.finish(output)


def plot_structural_rule_performance(rules: dict, output: Path) -> None:
    categories = rules["categories"]
    mdl_passes = sum(
        category["cross_validation"]["micro"]["mdl"]["passes_1_2x"]
        for category in categories
    )
    svg = Svg(
        "Category-conditioned structural rule performance",
        f"Three-fold held-out retrieval using typed AST neighborhoods; {mdl_passes} rules pass the 1.2× MDL proxy but none clears every promotion gate",
    )
    left, right, top, bottom = 135, 1295, 175, 680

    def x_position(value: float) -> float:
        return left + (right - left) * value

    def y_position(value: float) -> float:
        return bottom - (bottom - top) * value

    for tick in (0, 0.2, 0.4, 0.6, 0.8, 1.0):
        x = x_position(tick)
        y = y_position(tick)
        svg.line(x, top, x, bottom)
        svg.line(left, y, right, y)
        svg.text(x, bottom + 29, f"{tick:.0%}", cls="axis", anchor="middle")
        svg.text(left - 15, y + 5, f"{tick:.0%}", cls="axis", anchor="end")
    svg.line(x_position(0.40), top, x_position(0.40), bottom, stroke=MUTED, width=1.5, dash="7 6")
    svg.line(left, y_position(0.80), right, y_position(0.80), stroke=MUTED, width=1.5, dash="7 6")

    colors = {
        "strong_provisional": HIGH_CONFIDENCE,
        "weak_provisional": LOW_CONFIDENCE,
        "insufficient_structural_rule": ABSTAIN,
    }
    annotate = {
        "Python package setup configuration",
        "Grunt and Gulp workflow infrastructure",
        "Webpack build configuration",
        "Browser test launch configuration",
        "Trove taxonomy metadata",
    }
    for category in sorted(categories, key=lambda value: value["support"], reverse=True):
        result = category["cross_validation"]["micro"]
        x = x_position(result["recall"])
        y = y_position(result["precision"])
        radius = 4.5 + 1.8 * math.sqrt(category["support"])
        color = colors[category["status"]]
        svg.circle(x, y, radius, color, stroke="#ffffff", stroke_width=2)
        if category["meaning"] in annotate:
            x_offset = -12 if x > 1040 else 12
            anchor = "end" if x > 1040 else "start"
            svg.text(
                x + x_offset,
                y - 12,
                f"{compact_label(category['meaning'], 32)} · n={category['support']}",
                anchor=anchor,
                size=13,
                weight=700,
                fill=color,
            )

    svg.text((left + right) / 2, 752, "Held-out recall", cls="axis", anchor="middle")
    svg.text(left, 143, "Held-out precision", cls="axis")
    counts = rules["status_counts"]
    legend_x = 820
    for status, label in (
        ("weak_provisional", "Weak candidate"),
        ("insufficient_structural_rule", "Insufficient"),
    ):
        svg.circle(legend_x, 128, 7, colors[status])
        svg.text(legend_x + 15, 134, f"{label} ({counts.get(status, 0)})", size=14)
        legend_x += 220
    svg.text(
        70,
        798,
        "Dashed lines mark the precision/recall portion of the strong-rule gate. Circle area increases with semantic support; MDL, repository independence, and support gates are evaluated separately.",
        cls="note",
    )
    svg.finish(output)


def plot_semantic_expansion_loop(
    base_rules: dict,
    expanded_rules: dict,
    audit: dict,
    expanded_evaluation: dict,
    output: Path,
) -> None:
    meaning = "Python package setup configuration"
    base = next(category for category in base_rules["categories"] if category["meaning"] == meaning)
    expanded = next(category for category in expanded_rules["categories"] if category["meaning"] == meaning)
    audit_category = next(category for category in audit["categories"] if category["meaning"] == meaning)
    executable = next(result for result in expanded_evaluation["results"] if result["meaning"] == meaning)
    base_metrics = base["cross_validation"]["micro"]
    expanded_metrics = expanded["cross_validation"]["micro"]
    executable_metrics = executable["paired_verified_reference_metrics"]

    svg = Svg(
        "Semantic–structural feedback loop",
        "Traceable out-of-cluster matches expand a meaning, then the enlarged category re-induces a more discriminative code rule",
    )
    steps = [
        ("Executable matches", audit_category["out_of_cluster_match_count"], "outside the original cluster"),
        ("Meaning-entailing", sum(candidate["llm_verdict"] == "entails" for candidate in audit_category["candidates"]), "LLM judgment + code evidence"),
        ("Provisional expansion", audit_category["decision_counts"]["provisional_expand"], "also above the member-fit floor"),
        ("Held for review", audit_category["decision_counts"]["review"], "meaning fits, vector evidence weaker"),
    ]
    x_positions = [70, 400, 730, 1060]
    for index, ((label, value, note), x) in enumerate(zip(steps, x_positions, strict=True)):
        svg.rect(x, 155, 270, 145, "#f7f9fc", rx=12, stroke=GRID, stroke_width=1.5)
        svg.text(x + 20, 190, label, size=16, weight=700)
        svg.text(x + 20, 245, value, size=40, weight=700, fill=HIGH_CONFIDENCE if index == 2 else INK)
        svg.text(x + 20, 277, note, cls="note")
        if index < len(steps) - 1:
            svg.line(x + 270, 227, x_positions[index + 1], 227, stroke=MEDIUM_CONFIDENCE, width=3)

    metrics = [
        ("Category support", base["support"], expanded["support"], "changes"),
        ("Held-out precision", base_metrics["precision"], expanded_metrics["precision"], "percent"),
        ("Held-out recall", base_metrics["recall"], expanded_metrics["recall"], "percent"),
        ("MDL proxy", base_metrics["mdl"]["compression_ratio"], expanded_metrics["mdl"]["compression_ratio"], "ratio"),
    ]
    max_values = {"changes": 110.0, "percent": 1.0, "ratio": 2.2}
    svg.text(70, 365, "Re-induction result", weight=700, size=20)
    for index, (label, before, after, unit) in enumerate(metrics):
        y = 415 + index * 78
        svg.text(260, y + 21, label, anchor="end", size=16)
        scale = 850 / max_values[unit]
        svg.rect(285, y, float(before) * scale, 24, PALE, rx=5)
        svg.rect(285, y + 31, float(after) * scale, 24, HIGH_CONFIDENCE, rx=5)
        before_label = f"{before:.1%}" if unit == "percent" else f"{before:.2f}×" if unit == "ratio" else str(before)
        after_label = f"{after:.1%}" if unit == "percent" else f"{after:.2f}×" if unit == "ratio" else str(after)
        svg.text(295 + float(before) * scale, y + 19, before_label, size=14, weight=700, fill=INK)
        svg.text(295 + float(after) * scale, y + 50, after_label, size=14, weight=700, fill="#ffffff")
    svg.rect(1130, 405, 200, 190, "#f0fdf8", rx=12, stroke=HIGH_CONFIDENCE, stroke_width=1.5)
    svg.text(1230, 445, "Paired execution", anchor="middle", size=17, weight=700)
    svg.text(1230, 492, f"{executable_metrics['reference_precision']:.1%}", anchor="middle", size=31, weight=700, fill=HIGH_CONFIDENCE)
    svg.text(1230, 518, "reference precision", anchor="middle", cls="note")
    svg.text(1230, 558, f"{executable_metrics['reference_recall']:.1%} recall", anchor="middle", size=17, weight=700)
    svg.text(70, 772, "Gray bars: original cluster only. Green bars: 15 cumulative-evidence expansions included. This is provisional in-sample feedback, not independent validation or registry promotion.", cls="note")
    svg.finish(output)


def plot_component_category_hierarchy(hierarchy: dict, output: Path) -> None:
    components = hierarchy["components"]
    svg = Svg(
        "Broad component categories above grounded change meanings",
        f"{hierarchy['coherent_component_count']} coherent parents cover {hierarchy['leaves_with_component_membership']} of {hierarchy['eligible_leaf_count']} reliable leaves; overlap is allowed but bounded",
        height=900,
    )
    left, right = 390, 1280
    max_support = max(component["support"] for component in components)
    colors = [MEDIUM_CONFIDENCE, HIGH_CONFIDENCE, INTERSECTION, JAVASCRIPT]
    svg.text(70, 142, "Component category", cls="axis")
    svg.text(left, 142, "Unique supporting changes", cls="axis")
    for index, component in enumerate(components):
        y = 170 + index * 57
        width = (right - left) * component["support"] / max_support
        color = colors[index % len(colors)]
        svg.text(left - 20, y + 24, component["name"], anchor="end", size=16, weight=700)
        svg.rect(left, y, width, 32, color, rx=6)
        svg.text(left + width + 12, y + 23, f"{component['support']} changes · {component['child_count']} leaves", size=14, weight=700)
        if component["secondary_child_ids"]:
            svg.text(left + width + 210, y + 23, f"+{len(component['secondary_child_ids'])} overlap", size=13, fill=INTERSECTION, weight=700)
    svg.rect(70, 822, 1260, 45, "#f7f9fc", rx=8, stroke=GRID)
    svg.text(
        90,
        850,
        "Eight reliable meanings remain unassigned instead of being forced into a vague parent. Support is deduplicated by underlying change; these are candidate components, not universal coverage claims.",
        cls="note",
    )
    svg.finish(output)


def plot_static_component_coverage(coverage: dict, output: Path) -> None:
    summary = coverage["summary"]
    category_usage = sorted(
        coverage["category_usage"], key=lambda item: (-item["files"], item["name"])
    )
    recurring_gaps = [item for item in coverage["gap_clusters"] if item["support"] >= 2]
    svg = Svg(
        "Static component coverage on unseen repositories",
        "Repository-disjoint exploratory holdout; commit text withheld and unmatched files remain explicit gaps",
        height=980,
    )

    cards = [
        ("Held-out files", str(summary["files"]), f"{summary['repositories']} unseen repositories"),
        ("Useful existing match", f"{summary['coverage_rate']:.1%}", f"{summary['covered_files']} files"),
        ("Explicit abstention", f"{summary['abstention_rate']:.1%}", f"{summary['files'] - summary['covered_files']} files"),
        ("Embedding recall@3", f"{summary['embedding_recall_at_3']:.1%}", "against LLM-adjudicated matches"),
    ]
    for index, (label, value, note) in enumerate(cards):
        x = 70 + index * 320
        svg.rect(x, 135, 290, 118, "#f7f9fc", rx=10, stroke=GRID)
        svg.text(x + 18, 170, label, cls="note", weight=700)
        svg.text(x + 18, 217, value, size=31, weight=700, fill=HIGH_CONFIDENCE if index == 1 else INK)
        svg.text(x + 18, 239, note, cls="note")

    total = summary["files"]
    strong = round(summary["strong_match_rate"] * total)
    plausible = round(summary["plausible_match_rate"] * total)
    abstained = total - strong - plausible
    bar_x, bar_y, bar_width = 70, 315, 1260
    svg.text(bar_x, bar_y - 22, "Semantic adjudication", weight=700, size=19)
    cursor = bar_x
    for count, label, color in (
        (strong, "Strong", HIGH_CONFIDENCE),
        (plausible, "Plausible", MEDIUM_CONFIDENCE),
        (abstained, "No adequate category", ABSTAIN),
    ):
        width = bar_width * count / total
        svg.rect(cursor, bar_y, width, 58, color)
        svg.text(cursor + width / 2, bar_y + 37, f"{label} · {count}", anchor="middle", fill="#ffffff", weight=700, size=16)
        cursor += width

    svg.text(70, 440, "Existing category usage", weight=700, size=19)
    max_usage = max(item["files"] for item in category_usage)
    for index, item in enumerate(category_usage):
        column = 0 if index < 6 else 1
        row = index if column == 0 else index - 6
        x = 70 + column * 650
        y = 475 + row * 58
        label_width = 255
        bar_width = 285 * item["files"] / max_usage
        svg.text(x + label_width, y + 21, item["name"], anchor="end", size=14)
        svg.rect(x + label_width + 15, y, bar_width, 27, MEDIUM_CONFIDENCE, rx=5)
        svg.text(x + label_width + bar_width + 27, y + 20, item["files"], size=14, weight=700)

    gap_y = 830
    svg.text(70, gap_y, "Recurring uncovered responsibilities", weight=700, size=19)
    gap_names = "  ·  ".join(f"{item['name']} ({item['support']})" for item in recurring_gaps)
    svg.text(70, gap_y + 38, gap_names, size=15, fill=INTERSECTION, weight=700)
    svg.rect(70, 900, 1260, 48, "#f7f9fc", rx=8, stroke=GRID)
    svg.text(
        90,
        930,
        "All 11 existing categories were used. Coverage is exploratory, not precision: judgments are LLM-generated and still require human calibration.",
        cls="note",
    )
    svg.finish(output)


def plot_static_gap_expansion(expansion: dict, output: Path) -> None:
    categories = expansion["categories"]
    svg = Svg(
        "Open-vocabulary feedback from recurring static gaps",
        f"{expansion['summary']['retrieved_candidates']} similarity candidates audited; only code-entailing matches increase support",
    )
    left, right = 430, 1280
    maximum = max(item["total_support"] for item in categories)
    svg.text(70, 148, "Gap category", cls="axis")
    svg.text(left, 148, "Independent held-out files", cls="axis")
    for index, item in enumerate(categories):
        y = 190 + index * 102
        initial_width = (right - left) * item["initial_support"] / maximum
        expansion_width = (right - left) * item["accepted_expansions"] / maximum
        svg.text(left - 22, y + 31, item["name"], anchor="end", size=17, weight=700)
        svg.rect(left, y, initial_width, 45, PALE, rx=7)
        svg.rect(left + initial_width, y, expansion_width, 45, HIGH_CONFIDENCE, rx=7)
        svg.text(left + initial_width + expansion_width + 14, y + 29, f"{item['total_support']} total", size=15, weight=700)
        svg.text(
            left,
            y + 70,
            f"2 seeds + {item['accepted_expansions']} accepted from {item['candidate_count']} retrieved · {item['status'].replace('_', ' ')}",
            cls="note",
        )
    svg.rect(70, 720, 1260, 62, "#f7f9fc", rx=8, stroke=GRID)
    svg.text(90, 747, "Gray = original recurring holdout evidence. Green = new code-entailing matches from the 500-file repository-disjoint pool.", cls="note")
    svg.text(90, 771, "Only String processing algorithms reaches the provisional five-file support floor; no candidate is registered.", cls="note")
    svg.finish(output)


def plot_static_structure_validation(structure: dict, output: Path) -> None:
    train = structure["final_rule"]["in_sample_metrics"]
    held_out = structure["cross_validation"]
    svg = Svg(
        "Structural validation of the expanded static category",
        f"{structure['category']} · {structure['semantic_support']} positive files against {structure['negative_files']} pool negatives",
    )
    svg.text(70, 155, "A semantic umbrella must not become a structural primitive unless its rule transfers", weight=700, size=20)
    metrics = [
        ("Precision", train["precision"], held_out["precision"]),
        ("Recall", train["recall"], held_out["recall"]),
        ("F1", train["f1"], held_out["f1"]),
    ]
    left, width = 315, 900
    for index, (label, in_sample, cross_validated) in enumerate(metrics):
        y = 245 + index * 130
        svg.text(left - 25, y + 25, label, anchor="end", size=18, weight=700)
        svg.rect(left, y, width * in_sample, 35, MEDIUM_CONFIDENCE, rx=6)
        svg.text(left + width * in_sample + 14, y + 25, f"{in_sample:.1%} in-sample", size=15, weight=700)
        svg.rect(left, y + 52, width * cross_validated, 35, ABSTAIN, rx=6)
        svg.text(left + max(width * cross_validated, 4) + 14, y + 77, f"{cross_validated:.1%} leave-one-out", size=15, weight=700)
    svg.rect(70, 655, 1260, 112, "#fff7ed", rx=10, stroke=JAVASCRIPT, stroke_width=1.5)
    svg.text(95, 692, "Decision: keep semantic-only", weight=700, size=20, fill=JAVASCRIPT)
    svg.text(
        95,
        724,
        f"The fitted clauses cover {train['true_positive']}/{structure['semantic_support']} positives with {train['false_positive']} false positives; leave-one-out recovers {held_out['held_out_true_positive']}/{held_out['folds']}.",
        size=16,
    )
    svg.text(95, 752, "Next: split the semantic umbrella or collect more evidence; do not weaken the structural gate.", cls="note")
    svg.finish(output)


def plot_static_recursive_refinement(refinement: dict, expansion: dict, output: Path) -> None:
    accepted = [item for item in refinement["children"] if item["status"] == "accepted_for_structural_validation"]
    rejected = [item for item in refinement["children"] if item["status"] != "accepted_for_structural_validation"]
    expanded_by_id = {item["child_id"]: item for item in expansion["children"]}
    svg = Svg(
        "Recursive refinement after structural transfer fails",
        "Stable non-singleton meaning groups are named; residuals and one-example children remain outside promotion",
    )
    svg.rect(480, 135, 440, 90, "#eef2ff", rx=12, stroke=MEDIUM_CONFIDENCE)
    svg.text(700, 173, refinement["parent"]["name"], anchor="middle", weight=700, size=21)
    svg.text(700, 202, f"{refinement['member_count']} semantic members · structural transfer failed", anchor="middle", cls="note")
    svg.line(700, 225, 700, 290, stroke=MEDIUM_CONFIDENCE, width=3)

    x_positions = [180, 700, 1110]
    blocks = []
    for child in accepted:
        expanded = expanded_by_id.get(child["child_id"], {})
        blocks.append((child["name"], child["support"], expanded.get("accepted_expansions", 0), "accepted child", HIGH_CONFIDENCE))
    for child in rejected:
        blocks.append((child["name"], child["support"], 0, "insufficient child", JAVASCRIPT))
    blocks.append(("Residual meanings", len(refinement.get("residual_members", [])), 0, "unassigned", ABSTAIN))
    for x, (name, initial, added, status, color) in zip(x_positions, blocks, strict=False):
        svg.rect(x - 165, 290, 330, 150, "#f7f9fc", rx=12, stroke=color, stroke_width=2)
        svg.text(x, 330, name, anchor="middle", weight=700, size=18)
        svg.text(x, 382, f"{initial} + {added}", anchor="middle", weight=700, size=34, fill=color)
        svg.text(x, 412, "initial + audited expansion", anchor="middle", cls="note")
        svg.text(x, 462, status, anchor="middle", size=14, weight=700, fill=color)

    svg.rect(70, 545, 1260, 150, "#fff7ed", rx=12, stroke=JAVASCRIPT)
    svg.text(95, 585, "Current decision", weight=700, size=20, fill=JAVASCRIPT)
    accepted_total = sum(initial + added for _name, initial, added, status, _color in blocks if status == "accepted child")
    svg.text(95, 622, f"Text normalization is coherent and reaches {accepted_total} audited files after the approved larger retrieval run.", size=16)
    svg.text(95, 653, "Text filter pipelines retains one member; palindrome search and format validation remain residuals. No child receives a structural rule.", size=16)
    svg.text(95, 681, "Support alone is insufficient: the 10-file normalization child still fails leave-one-positive-out structural transfer.", cls="note")
    svg.finish(output)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        type=Path,
        default=Path(".data/intent-pilot"),
        help="Directory containing summary.json, sample-results.jsonl, and signature-counts.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("docs/figures/intent-algebra"),
        help="Destination directory for SVG figures",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    summary = json.loads((args.input / "summary.json").read_text(encoding="utf-8"))
    signatures = json.loads((args.input / "signature-counts.json").read_text(encoding="utf-8"))
    with (args.input / "sample-results.jsonl").open(encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle if line.strip()]

    plot_filter_funnel(summary, args.output / "01-corpus-filter-funnel.svg")
    plot_ast_outcomes(summary, args.output / "02-ast-eligibility-outcomes.svg")
    plot_component_distribution(rows, args.output / "03-component-count-distribution.svg")
    plot_signature_recurrence(signatures, summary, args.output / "04-signature-recurrence.svg")
    figure_count = 4
    expansion_path = args.input / "base-within-component-expansions.json"
    if expansion_path.exists():
        expansion = json.loads(expansion_path.read_text(encoding="utf-8"))
        plot_expansion_candidates(expansion, args.output / "05-within-component-expansion.svg")
        figure_count += 1
    refinement_path = args.input / "recursive-semantic-refinement.json"
    if refinement_path.exists():
        refinement = json.loads(refinement_path.read_text(encoding="utf-8"))
        plot_semantic_refinement(refinement, args.output / "06-recursive-semantic-refinement.svg")
        figure_count += 1
    grounding_path = args.input / "grounded-semantic-meanings.json"
    if grounding_path.exists():
        grounding = json.loads(grounding_path.read_text(encoding="utf-8"))
        plot_meaning_confidence(grounding, args.output / "07-meaning-confidence.svg")
        figure_count += 1
    structural_path = args.input / "category-structural-rules.json"
    if structural_path.exists():
        rules = json.loads(structural_path.read_text(encoding="utf-8"))
        plot_structural_rule_performance(rules, args.output / "08-structural-rule-performance.svg")
        figure_count += 1
    expanded_rules_path = args.input / "category-structural-rules-expanded.json"
    audit_path = args.input / "semantic-expansion-audit.json"
    expanded_evaluation_path = args.input / "paired-semgrep-evaluation-expanded.json"
    if structural_path.exists() and expanded_rules_path.exists() and audit_path.exists() and expanded_evaluation_path.exists():
        plot_semantic_expansion_loop(
            json.loads(structural_path.read_text(encoding="utf-8")),
            json.loads(expanded_rules_path.read_text(encoding="utf-8")),
            json.loads(audit_path.read_text(encoding="utf-8")),
            json.loads(expanded_evaluation_path.read_text(encoding="utf-8")),
            args.output / "09-semantic-structural-feedback-loop.svg",
        )
        figure_count += 1
    component_hierarchy_path = args.input / "component-category-hierarchy.json"
    if component_hierarchy_path.exists():
        plot_component_category_hierarchy(
            json.loads(component_hierarchy_path.read_text(encoding="utf-8")),
            args.output / "10-component-category-hierarchy.svg",
        )
        figure_count += 1
    static_coverage_path = args.input / "static-component-coverage.json"
    if static_coverage_path.exists():
        plot_static_component_coverage(
            json.loads(static_coverage_path.read_text(encoding="utf-8")),
            args.output / "11-static-component-coverage.svg",
        )
        figure_count += 1
    static_gap_path = args.input / "static-gap-expansions.json"
    if static_gap_path.exists():
        plot_static_gap_expansion(
            json.loads(static_gap_path.read_text(encoding="utf-8")),
            args.output / "12-static-gap-feedback.svg",
        )
        figure_count += 1
    static_structure_path = args.input / "static-component-structure.json"
    if static_structure_path.exists():
        plot_static_structure_validation(
            json.loads(static_structure_path.read_text(encoding="utf-8")),
            args.output / "13-static-structure-validation.svg",
        )
        figure_count += 1
    static_refinement_path = args.input / "static-component-refinement.json"
    static_child_expansion_path = args.input / "static-child-expansions.json"
    if static_refinement_path.exists() and static_child_expansion_path.exists():
        plot_static_recursive_refinement(
            json.loads(static_refinement_path.read_text(encoding="utf-8")),
            json.loads(static_child_expansion_path.read_text(encoding="utf-8")),
            args.output / "14-static-recursive-refinement.svg",
        )
        figure_count += 1
    static_normalization_structure_path = args.input / "static-normalization-structure.json"
    if static_normalization_structure_path.exists():
        plot_static_structure_validation(
            json.loads(static_normalization_structure_path.read_text(encoding="utf-8")),
            args.output / "15-static-normalization-structure.svg",
        )
        figure_count += 1
    print(f"Wrote {figure_count} figures to {args.output}")


if __name__ == "__main__":
    main()

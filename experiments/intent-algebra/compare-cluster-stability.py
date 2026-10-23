#!/usr/bin/env python3
"""Compare embedding clusters across nested deterministic corpus samples."""

from __future__ import annotations

import argparse
from collections import Counter
from html import escape
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old", type=Path, required=True)
    parser.add_argument("--new", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--markdown", type=Path, required=True)
    parser.add_argument("--figure", type=Path, required=True)
    return parser.parse_args()


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def terms(label: str) -> set[str]:
    return {term.strip() for term in label.split("·") if term.strip()}


def classify(retention: float, label_overlap: float, destination: str | None) -> str:
    if destination is None:
        return "dissolved"
    if retention >= 0.75 and label_overlap >= 1 / 3:
        return "stable_expansion"
    if retention >= 0.75:
        return "membership_stable_label_shift"
    if retention >= 0.50:
        return "partial_split"
    return "split"


def compare(old: dict, new: dict) -> list[dict]:
    new_by_id = {cluster["cluster_id"]: cluster for cluster in new["clusters"]}
    destination_by_sample = {
        member["sample_id"]: cluster["cluster_id"]
        for cluster in new["clusters"]
        for member in cluster["members"]
    }
    rows = []
    for cluster in old["clusters"]:
        destinations = Counter()
        for member in cluster["members"]:
            sample_id = member["sample_id"]
            destination = destination_by_sample.get(sample_id)
            destinations[destination or f"SINGLETON:{sample_id}"] += 1
        destination_id, overlap = destinations.most_common(1)[0]
        destination = new_by_id.get(destination_id)
        destination_label = destination["label"] if destination else None
        old_terms = terms(cluster["label"])
        new_terms = terms(destination_label or "")
        label_overlap = len(old_terms & new_terms) / max(len(old_terms | new_terms), 1)
        retention = overlap / cluster["support"]
        rows.append({
            "old_cluster_id": cluster["cluster_id"],
            "old_label": cluster["label"],
            "old_support": cluster["support"],
            "destination_cluster_id": destination_id if destination else None,
            "destination_label": destination_label,
            "destination_support": destination["support"] if destination else None,
            "overlap": overlap,
            "member_retention": round(retention, 6),
            "destination_count": len(destinations),
            "label_token_jaccard": round(label_overlap, 6),
            "expansion_factor": round(destination["support"] / cluster["support"], 3) if destination else None,
            "status": classify(retention, label_overlap, destination_id if destination else None),
            "destinations": [
                {"cluster_id": key if not key.startswith("SINGLETON:") else None, "overlap": count}
                for key, count in destinations.most_common()
            ],
        })
    return rows


def write_markdown(rows: list[dict], path: Path, old: dict, new: dict) -> None:
    counts = Counter(row["status"] for row in rows)
    lines = [
        "# Nested-sample semantic cluster stability",
        "",
        f"Compared {len(rows)} multi-record clusters from {old['records']} retained changes "
        f"against {new['multi_record_cluster_count']} clusters from {new['records']} retained changes.",
        "",
        "| Status | Earlier clusters |",
        "|---|---:|",
    ]
    for status, count in sorted(counts.items()):
        lines.append(f"| {status.replace('_', ' ')} | {count} |")
    lines.extend([
        "",
        "| Earlier cluster | n | Larger-sweep destination | overlap | destination n | status |",
        "|---|---:|---|---:|---:|---|",
    ])
    for row in sorted(rows, key=lambda value: (-value["old_support"], value["old_cluster_id"])):
        destination = row["destination_label"] or "dissolved into singletons/splits"
        destination_support = row["destination_support"] or "—"
        lines.append(
            f"| {row['old_cluster_id']} — {row['old_label']} | {row['old_support']} | "
            f"{destination} | {row['overlap']}/{row['old_support']} | {destination_support} | "
            f"{row['status'].replace('_', ' ')} |"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_svg(rows: list[dict], path: Path, old: dict, new: dict) -> None:
    shown = sorted(rows, key=lambda value: (-value["old_support"], value["old_cluster_id"]))[:20]
    width = 1500
    row_height = 46
    height = 160 + row_height * len(shown) + 70
    colors = {
        "stable_expansion": "#138a72",
        "membership_stable_label_shift": "#d97706",
        "partial_split": "#7c3aed",
        "split": "#d94f70",
        "dissolved": "#667085",
    }
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        '<style>text{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#172033}.title{font-size:30px;font-weight:700}.sub{font-size:16px;fill:#667085}.label{font-size:14px;font-weight:600}.note{font-size:13px;fill:#667085}.value{font-size:13px;font-weight:700}</style>',
        '<text x="55" y="52" class="title">Semantic cluster stability under nested sample expansion</text>',
        f'<text x="55" y="82" class="sub">Exact member retention from {old["records"]:,} retained changes into {new["records"]:,} retained changes</text>',
        '<text x="55" y="119" class="note">Earlier cluster</text>',
        '<text x="565" y="119" class="note">Retained together</text>',
        '<text x="895" y="119" class="note">Larger-sweep destination</text>',
    ]
    for index, row in enumerate(shown):
        y = 140 + index * row_height
        color = colors[row["status"]]
        bar_width = 260 * row["member_retention"]
        old_label = escape(f"{row['old_cluster_id']}  {row['old_label']} (n={row['old_support']})")
        destination = escape(row["destination_label"] or "split / singleton")
        parts.extend([
            f'<text x="55" y="{y + 20}" class="label">{old_label}</text>',
            f'<rect x="565" y="{y + 5}" width="260" height="21" rx="4" fill="#edf0f5"/>',
            f'<rect x="565" y="{y + 5}" width="{bar_width:.1f}" height="21" rx="4" fill="{color}"/>',
            f'<text x="835" y="{y + 20}" class="value">{row["overlap"]}/{row["old_support"]}</text>',
            f'<text x="895" y="{y + 20}" class="label">{destination}</text>',
            f'<text x="1385" y="{y + 20}" class="note" text-anchor="end">{escape(row["status"].replace("_", " "))}</text>',
        ])
    parts.append(f'<text x="55" y="{height - 30}" class="note">Green indicates stable membership and label; orange preserves members but shifts label; purple/red indicate splitting.</text>')
    parts.append("</svg>")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(parts) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    old = load(args.old)
    new = load(args.new)
    rows = compare(old, new)
    payload = {
        "method": "exact member tracking across nested deterministic samples",
        "old_records": old["records"],
        "new_records": new["records"],
        "status_counts": dict(Counter(row["status"] for row in rows)),
        "clusters": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    write_markdown(rows, args.markdown, old, new)
    write_svg(rows, args.figure, old, new)
    print(f"Compared {len(rows)} earlier clusters; wrote {args.output}, {args.markdown}, and {args.figure}")


if __name__ == "__main__":
    main()

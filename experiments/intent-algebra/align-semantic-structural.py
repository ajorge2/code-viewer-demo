#!/usr/bin/env python3
"""Align semantic categories with traceable structural rule candidates.

Semantic clusters are the primary records. Frequent base patterns and exact-host
within-component composites become candidate clauses explaining each category.
Shared sample IDs provide the join, and recurrent clause co-occurrence supplies
proposals for the next recursive composition pass.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--semantic-clusters", type=Path, required=True)
    parser.add_argument("--bases", type=Path, required=True)
    parser.add_argument("--composites", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--min-overlap", type=int, default=2)
    parser.add_argument("--max-clauses", type=int, default=6)
    parser.add_argument("--max-recursive-proposals", type=int, default=8)
    return parser.parse_args()


def safe_ratio(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def f1(left: float, right: float) -> float:
    return 2 * left * right / (left + right) if left + right else 0.0


def base_signature(pattern: dict) -> str:
    labels = [node["label"] for node in pattern["nodes"]]
    return " + ".join(labels)


def load_structural_candidates(bases_path: Path, composites_path: Path) -> list[dict]:
    bases = json.loads(bases_path.read_text(encoding="utf-8"))["patterns"]
    composite_payload = json.loads(composites_path.read_text(encoding="utf-8"))
    candidates = [
        {
            "candidate_id": f"PILOT_GSPAN_{pattern['id']:04d}",
            "kind": "base",
            "support": len(set(pattern["sample_ids"])),
            "sample_ids": sorted(set(pattern["sample_ids"])),
            "contains": [],
            "structural_signature": base_signature(pattern),
        }
        for pattern in bases
    ]
    candidates.extend(
        {
            "candidate_id": candidate["candidate_id"],
            "kind": "within_component_composite",
            "support": candidate["commit_support"],
            "sample_ids": candidate["sample_ids"],
            "contains": candidate["contains"],
            "structural_signature": candidate["coedit_signature"],
            "context_nodes": candidate["maximum_context_nodes"],
            "cross_anchor_intersection": candidate["is_cross_anchor_intersection"],
        }
        for candidate in composite_payload["composites"]
    )
    return candidates


def alignment_metrics(
    semantic_ids: set[str], structural_ids: set[str], universe_size: int
) -> dict:
    overlap_ids = semantic_ids & structural_ids
    overlap = len(overlap_ids)
    semantic_coverage = safe_ratio(overlap, len(semantic_ids))
    structural_purity = safe_ratio(overlap, len(structural_ids))
    union = len(semantic_ids | structural_ids)
    expected = safe_ratio(len(semantic_ids) * len(structural_ids), universe_size)
    return {
        "overlap": overlap,
        "semantic_coverage": semantic_coverage,
        "structural_purity": structural_purity,
        "jaccard": safe_ratio(overlap, union),
        "lift_over_chance": safe_ratio(overlap, expected),
        "balanced_alignment": f1(semantic_coverage, structural_purity),
        "overlap_sample_ids": sorted(overlap_ids),
    }


def select_rule_clauses(
    alignments: list[dict], semantic_ids: set[str], max_clauses: int
) -> tuple[list[dict], set[str], set[str]]:
    ranked = sorted(
        alignments,
        key=lambda item: (
            -item["balanced_alignment"],
            -item["lift_over_chance"],
            -item["overlap"],
            item["candidate_id"],
        ),
    )
    selected = []
    covered_semantic: set[str] = set()
    rule_hosts: set[str] = set()
    for alignment in ranked:
        overlap_ids = set(alignment["overlap_sample_ids"])
        if not overlap_ids - covered_semantic:
            continue
        if alignment["structural_purity"] < 0.10:
            continue
        selected.append(alignment)
        covered_semantic.update(overlap_ids)
        rule_hosts.update(alignment["structural_sample_ids"])
        if len(selected) >= max_clauses:
            break
    return selected, covered_semantic, rule_hosts


def recursive_proposals(
    alignments: list[dict],
    semantic_ids: set[str],
    min_overlap: int,
    limit: int,
) -> list[dict]:
    proposals = []
    for left_index, left in enumerate(alignments):
        left_hosts = set(left["structural_sample_ids"])
        for right in alignments[left_index + 1 :]:
            # A composite paired with one of its own base anchors is tautological,
            # not a new recursive composition proposal.
            if (
                left["candidate_id"] in right.get("contains", [])
                or right["candidate_id"] in left.get("contains", [])
            ):
                continue
            right_hosts = set(right["structural_sample_ids"])
            joint_hosts = left_hosts & right_hosts
            joint_semantic = joint_hosts & semantic_ids
            if len(joint_semantic) < min_overlap:
                continue
            joint_purity = safe_ratio(len(joint_semantic), len(joint_hosts))
            joint_coverage = safe_ratio(len(joint_semantic), len(semantic_ids))
            proposals.append({
                "operator": "AND",
                "candidate_ids": sorted([left["candidate_id"], right["candidate_id"]]),
                "cooccurring_commits": len(joint_hosts),
                "semantic_cooccurrence": len(joint_semantic),
                "semantic_coverage": joint_coverage,
                "joint_structural_purity": joint_purity,
                "score": f1(joint_coverage, joint_purity),
                "sample_ids": sorted(joint_semantic),
            })
    proposals.sort(
        key=lambda item: (-item["score"], -item["semantic_cooccurrence"], item["candidate_ids"])
    )
    return proposals[:limit]


def main() -> None:
    args = parse_args()
    semantic_payload = json.loads(args.semantic_clusters.read_text(encoding="utf-8"))
    candidates = load_structural_candidates(args.bases, args.composites)
    universe_size = int(semantic_payload["records"])
    categories = []

    for cluster in semantic_payload["clusters"]:
        semantic_ids = {member["sample_id"] for member in cluster["members"]}
        alignments = []
        for candidate in candidates:
            structural_ids = set(candidate["sample_ids"])
            metrics = alignment_metrics(semantic_ids, structural_ids, universe_size)
            if metrics["overlap"] < args.min_overlap:
                continue
            alignments.append({
                "candidate_id": candidate["candidate_id"],
                "kind": candidate["kind"],
                "structural_signature": candidate["structural_signature"],
                "structural_support": candidate["support"],
                "structural_sample_ids": candidate["sample_ids"],
                "contains": candidate.get("contains", []),
                **metrics,
            })

        selected, covered_semantic, rule_hosts = select_rule_clauses(
            alignments, semantic_ids, args.max_clauses
        )
        rule_precision = safe_ratio(len(rule_hosts & semantic_ids), len(rule_hosts))
        rule_coverage = safe_ratio(len(covered_semantic), len(semantic_ids))
        proposals = recursive_proposals(
            alignments,
            semantic_ids,
            args.min_overlap,
            args.max_recursive_proposals,
        )
        if not selected:
            rule_status = "no_recurrent_structural_rule"
        elif rule_coverage >= 0.50 and rule_precision >= 0.50:
            rule_status = "strong_provisional_rule"
        else:
            rule_status = "partial_provisional_rule"
        categories.append({
            "semantic_cluster_id": cluster["cluster_id"],
            "semantic_label": cluster["label"],
            "semantic_support": len(semantic_ids),
            "priority": "semantic_category",
            "rule_status": rule_status,
            "structural_rule": {
                "operator": "OR",
                "clause_candidate_ids": [item["candidate_id"] for item in selected],
                "semantic_coverage": rule_coverage,
                "rule_precision": rule_precision,
                "covered_semantic_sample_ids": sorted(covered_semantic),
            },
            "ranked_structural_clauses": [
                {key: value for key, value in item.items() if key != "structural_sample_ids"}
                for item in sorted(
                    alignments,
                    key=lambda value: (-value["balanced_alignment"], -value["overlap"]),
                )
            ],
            "recursive_and_proposals": proposals,
        })

    status_counts: dict[str, int] = {}
    for category in categories:
        status_counts[category["rule_status"]] = status_counts.get(category["rule_status"], 0) + 1
    payload = {
        "method": "semantic-first sample-ID alignment with structural rule induction",
        "precedence": "semantic categories are primary; structural patterns are explanatory clauses",
        "universe_size": universe_size,
        "semantic_category_count": len(categories),
        "structural_candidate_count": len(candidates),
        "parameters": {
            "minimum_overlap": args.min_overlap,
            "maximum_or_clauses": args.max_clauses,
            "maximum_recursive_and_proposals": args.max_recursive_proposals,
            "rule_clause_minimum_structural_purity": 0.10,
            "strong_rule_thresholds": {
                "semantic_coverage": 0.50,
                "rule_precision": 0.50,
            },
        },
        "rule_status_counts": status_counts,
        "categories": categories,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(
        f"Aligned {len(categories)} semantic categories with {len(candidates)} structural candidates: "
        + ", ".join(f"{key}={value}" for key, value in sorted(status_counts.items()))
    )


if __name__ == "__main__":
    main()

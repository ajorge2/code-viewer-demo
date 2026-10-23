#!/usr/bin/env python3
"""Recursively discover more specific semantic meanings inside semantic clusters.

The harness is deliberately semantic-first. It reuses cached embeddings, evaluates
candidate downward splits, preserves soft cross-child memberships, and only then ranks
base/composite structural patterns as explanatory rules for every semantic node.
"""

from __future__ import annotations

import argparse
from collections import Counter
from hashlib import sha256
import importlib.util
import json
import math
from pathlib import Path

import numpy as np
from sklearn.cluster import AgglomerativeClustering
from sklearn.metrics import adjusted_rand_score, pairwise_distances, silhouette_score


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clusters", type=Path, required=True)
    parser.add_argument("--facets", type=Path, required=True)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--embedding-cache", type=Path, required=True)
    parser.add_argument("--bases", type=Path, required=True)
    parser.add_argument("--composites", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-depth", type=int, default=4)
    parser.add_argument("--min-parent-size", type=int, default=6)
    parser.add_argument("--min-child-size", type=int, default=3)
    parser.add_argument("--min-coverage", type=float, default=0.60)
    parser.add_argument("--min-cohesion-gain", type=float, default=0.03)
    parser.add_argument("--min-silhouette", type=float, default=0.10)
    parser.add_argument("--min-stability", type=float, default=0.55)
    parser.add_argument("--min-label-distinctness", type=float, default=0.30)
    parser.add_argument("--soft-membership-margin", type=float, default=0.025)
    parser.add_argument("--max-soft-memberships", type=int, default=2)
    parser.add_argument("--stability-repeats", type=int, default=12)
    parser.add_argument(
        "--thresholds",
        default="0.06,0.08,0.10,0.12,0.14,0.16,0.18,0.20,0.22,0.24,0.26",
    )
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def load_embedding_helpers(path: Path):
    spec = importlib.util.spec_from_file_location("intent_embedding_helpers", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import embedding helpers from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cache_key(model: str, dimensions: int, text: str) -> str:
    material = json.dumps(
        {"model": model, "dimensions": dimensions, "text": text},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return sha256(material.encode("utf-8")).hexdigest()


def normalized_matrix(
    records: list[dict], samples: dict[str, dict], cache_path: Path, helpers
) -> np.ndarray:
    cache = json.loads(cache_path.read_text(encoding="utf-8"))
    model = cache["model"]
    dimensions = int(cache["dimensions"])
    vectors = []
    missing = []
    for record in records:
        text = helpers.embedding_text(record, samples[record["sample_id"]])
        key = cache_key(model, dimensions, text)
        vector = cache["embeddings"].get(key)
        if vector is None:
            missing.append(record["sample_id"])
        else:
            vectors.append(vector)
    if missing:
        raise RuntimeError(f"Embedding cache is missing {len(missing)} refinement records")
    matrix = np.asarray(vectors, dtype=np.float64)
    return matrix / np.linalg.norm(matrix, axis=1, keepdims=True)


def fit_labels(matrix: np.ndarray, threshold: float) -> np.ndarray:
    return AgglomerativeClustering(
        n_clusters=None,
        metric="cosine",
        linkage="average",
        distance_threshold=threshold,
    ).fit_predict(matrix)


def mean_pairwise_similarity(matrix: np.ndarray) -> float:
    if len(matrix) < 2:
        return 1.0
    similarities = 1 - pairwise_distances(matrix, metric="cosine")
    return float(similarities[np.triu_indices(len(matrix), k=1)].mean())


def weighted_child_cohesion(matrix: np.ndarray, groups: list[list[int]]) -> float:
    weights = [len(group) for group in groups]
    values = [mean_pairwise_similarity(matrix[group]) for group in groups]
    return float(np.average(values, weights=weights))


def group_terms(records: list[dict], helpers) -> list[str]:
    return [term["term"] for term in helpers.label_tokens(records)[:3]]


def label_distinctness(groups: list[list[int]], records: list[dict], helpers) -> tuple[float, list[list[str]]]:
    terms = [group_terms([records[index] for index in group], helpers) for group in groups]
    if len(terms) < 2:
        return 0.0, terms
    distances = []
    for left in range(len(terms)):
        for right in range(left + 1, len(terms)):
            left_terms = set(terms[left])
            right_terms = set(terms[right])
            union = left_terms | right_terms
            distances.append(1 - len(left_terms & right_terms) / len(union) if union else 0.0)
    return float(np.mean(distances)), terms


def split_stability(
    matrix: np.ndarray,
    labels: np.ndarray,
    threshold: float,
    repeats: int,
    seed: int,
) -> float:
    if len(matrix) < 4:
        return 1.0
    rng = np.random.default_rng(seed)
    values = []
    sample_size = max(4, math.ceil(len(matrix) * 0.80))
    for _ in range(repeats):
        indexes = np.sort(rng.choice(len(matrix), size=sample_size, replace=False))
        sampled_labels = fit_labels(matrix[indexes], threshold)
        values.append(float(adjusted_rand_score(labels[indexes], sampled_labels)))
    return float(np.mean(values))


def structural_candidates(bases_path: Path, composites_path: Path) -> list[dict]:
    bases = json.loads(bases_path.read_text(encoding="utf-8"))["patterns"]
    composites = json.loads(composites_path.read_text(encoding="utf-8"))["composites"]
    output = [{
        "candidate_id": f"PILOT_GSPAN_{pattern['id']:04d}",
        "kind": "base",
        "sample_ids": set(pattern["sample_ids"]),
        "signature": " + ".join(node["label"] for node in pattern["nodes"]),
    } for pattern in bases]
    output.extend({
        "candidate_id": candidate["candidate_id"],
        "kind": "within_component_composite",
        "sample_ids": set(candidate["sample_ids"]),
        "signature": candidate["coedit_signature"],
    } for candidate in composites)
    return output


def structural_rules(
    member_ids: set[str],
    parent_ids: set[str] | None,
    candidates: list[dict],
    universe_size: int,
) -> list[dict]:
    rules = []
    sibling_ids = (parent_ids - member_ids) if parent_ids else set()
    for candidate in candidates:
        hosts = candidate["sample_ids"]
        overlap = member_ids & hosts
        if len(overlap) < 2:
            continue
        coverage = len(overlap) / len(member_ids)
        purity = len(overlap) / len(hosts)
        expected = len(member_ids) * len(hosts) / universe_size
        sibling_prevalence = len(sibling_ids & hosts) / len(sibling_ids) if sibling_ids else 0.0
        rules.append({
            "candidate_id": candidate["candidate_id"],
            "kind": candidate["kind"],
            "signature": candidate["signature"],
            "overlap": len(overlap),
            "semantic_coverage": coverage,
            "global_structural_purity": purity,
            "lift_over_chance": len(overlap) / expected if expected else 0.0,
            "prevalence_advantage_over_siblings": coverage - sibling_prevalence,
            "sample_ids": sorted(overlap),
        })
    rules.sort(
        key=lambda rule: (
            -rule["prevalence_advantage_over_siblings"],
            -rule["semantic_coverage"],
            -rule["global_structural_purity"],
            rule["candidate_id"],
        )
    )
    return rules[:8]


def candidate_split(
    indexes: list[int],
    matrix: np.ndarray,
    records: list[dict],
    helpers,
    threshold: float,
    args: argparse.Namespace,
    seed: int,
) -> dict | None:
    local_matrix = matrix[indexes]
    raw_labels = fit_labels(local_matrix, threshold)
    raw_groups: dict[int, list[int]] = {}
    for local_index, label in enumerate(raw_labels):
        raw_groups.setdefault(int(label), []).append(local_index)
    kept_groups = [group for group in raw_groups.values() if len(group) >= args.min_child_size]
    kept_groups.sort(key=lambda group: (-len(group), min(group)))
    if len(kept_groups) < 2:
        return None
    covered_local = sorted(index for group in kept_groups for index in group)
    coverage = len(covered_local) / len(indexes)
    if coverage < args.min_coverage:
        return None
    child_cohesion = weighted_child_cohesion(local_matrix, kept_groups)
    parent_cohesion = mean_pairwise_similarity(local_matrix)
    gain = child_cohesion - parent_cohesion
    kept_labels = []
    for group_number, group in enumerate(kept_groups):
        kept_labels.extend((index, group_number) for index in group)
    kept_labels.sort()
    kept_positions = [item[0] for item in kept_labels]
    label_values = np.asarray([item[1] for item in kept_labels])
    silhouette = float(silhouette_score(local_matrix[kept_positions], label_values, metric="cosine"))
    distinctness, terms = label_distinctness(
        [[indexes[local] for local in group] for group in kept_groups], records, helpers
    )
    stability = split_stability(local_matrix, raw_labels, threshold, args.stability_repeats, seed)
    accepted = (
        gain >= args.min_cohesion_gain
        and silhouette >= args.min_silhouette
        and stability >= args.min_stability
        and distinctness >= args.min_label_distinctness
    )
    score = gain + 0.15 * silhouette + 0.10 * stability + 0.05 * distinctness + 0.05 * coverage
    return {
        "threshold": threshold,
        "accepted": accepted,
        "score": score,
        "coverage": coverage,
        "parent_cohesion": parent_cohesion,
        "child_cohesion": child_cohesion,
        "cohesion_gain": gain,
        "silhouette": silhouette,
        "subsample_stability_ari": stability,
        "label_distinctness": distinctness,
        "child_terms": terms,
        "groups": [[indexes[local] for local in group] for group in kept_groups],
        "residual_indexes": [indexes[local] for local in range(len(indexes)) if local not in covered_local],
    }


def soft_memberships(
    parent_indexes: list[int],
    groups: list[list[int]],
    matrix: np.ndarray,
    threshold: float,
    margin: float,
    maximum_memberships: int,
) -> list[list[int]]:
    centroids = []
    for group in groups:
        centroid = matrix[group].mean(axis=0)
        centroids.append(centroid / np.linalg.norm(centroid))
    distances = pairwise_distances(matrix[parent_indexes], np.asarray(centroids), metric="cosine")
    memberships = [set(group) for group in groups]
    hard_child_by_index = {
        global_index: child_index
        for child_index, group in enumerate(groups)
        for global_index in group
    }
    for local_index, global_index in enumerate(parent_indexes):
        order = np.argsort(distances[local_index])
        best = float(distances[local_index, order[0]])
        selected = set()
        hard_child = hard_child_by_index.get(global_index)
        if hard_child is not None:
            selected.add(hard_child)
        for child_index in order:
            if len(selected) >= maximum_memberships:
                break
            distance = float(distances[local_index, child_index])
            if distance <= best + margin and distance <= threshold + margin:
                selected.add(int(child_index))
        for child_index in selected:
            memberships[child_index].add(global_index)
    memberships = [sorted(members) for members in memberships]
    return memberships


def validate_hierarchy(nodes: dict[str, dict], roots: list[str], maximum_soft_memberships: int) -> dict:
    if len(roots) != len(set(roots)):
        raise ValueError("Semantic refinement roots are not unique")
    visited: set[str] = set()
    active: set[str] = set()

    def visit(node_id: str) -> None:
        if node_id in active:
            raise ValueError(f"Cycle detected at {node_id}")
        if node_id in visited:
            return
        active.add(node_id)
        node = nodes[node_id]
        parent_members = set(node["hard_member_ids"])
        hard_seen: set[str] = set()
        soft_counts: Counter[str] = Counter()
        for child_id in node.get("contains", []):
            if child_id not in nodes:
                raise ValueError(f"Missing child node {child_id}")
            child = nodes[child_id]
            if child.get("is_contained_by") != [node_id]:
                raise ValueError(f"Invalid parent pointer for {child_id}")
            if child["depth"] != node["depth"] + 1:
                raise ValueError(f"Invalid depth transition for {child_id}")
            hard_members = set(child["hard_member_ids"])
            soft_members = set(child["soft_member_ids"])
            if not hard_members <= parent_members or not soft_members <= parent_members:
                raise ValueError(f"Child membership escapes parent at {child_id}")
            if hard_seen & hard_members:
                raise ValueError(f"Hard child memberships overlap under {node_id}")
            hard_seen.update(hard_members)
            soft_counts.update(soft_members)
            visit(child_id)
        if soft_counts and max(soft_counts.values()) > maximum_soft_memberships:
            raise ValueError(f"Soft membership cap exceeded under {node_id}")
        active.remove(node_id)
        visited.add(node_id)

    for root_id in roots:
        visit(root_id)
    if visited != set(nodes):
        raise ValueError("Semantic refinement contains nodes unreachable from roots")
    return {
        "status": "passed",
        "cycle_free": True,
        "parent_child_membership_contained": True,
        "hard_siblings_disjoint": True,
        "soft_membership_cap_respected": True,
        "all_nodes_reachable": True,
    }


def main() -> None:
    args = parse_args()
    thresholds = [float(value) for value in args.thresholds.split(",") if value.strip()]
    cluster_payload = json.loads(args.clusters.read_text(encoding="utf-8"))
    facets = read_jsonl(args.facets)
    samples = {sample["sample_id"]: sample for sample in read_jsonl(args.samples)}
    helpers = load_embedding_helpers(Path(__file__).with_name("cluster-embedding-concepts.py"))
    records = []
    for record in facets:
        enriched = dict(record)
        enriched["repositories"] = helpers.repository_names(samples[record["sample_id"]])
        records.append(enriched)
    index_by_id = {record["sample_id"]: index for index, record in enumerate(records)}
    matrix = normalized_matrix(records, samples, args.embedding_cache, helpers)
    candidates = structural_candidates(args.bases, args.composites)
    nodes: dict[str, dict] = {}
    roots = []
    split_diagnostics = Counter()

    def recurse(
        node_id: str,
        indexes: list[int],
        depth: int,
        parent_ids: set[str] | None,
    ) -> None:
        member_ids = {records[index]["sample_id"] for index in indexes}
        terms = helpers.label_tokens([records[index] for index in indexes])
        node = nodes[node_id]
        node.update({
            "label": helpers.noun_label(terms),
            "terms": terms,
            "depth": depth,
            "support": len(indexes),
            "hard_member_ids": sorted(member_ids),
            "contains": [],
            "structural_rule_candidates": structural_rules(
                member_ids, parent_ids, candidates, len(records)
            ),
        })
        if depth >= args.max_depth:
            node["stop_reason"] = "maximum_depth"
            split_diagnostics[node["stop_reason"]] += 1
            return
        if len(indexes) < args.min_parent_size:
            node["stop_reason"] = "parent_too_small"
            split_diagnostics[node["stop_reason"]] += 1
            return

        evaluated = []
        seed_material = int(sha256(node_id.encode("utf-8")).hexdigest()[:8], 16)
        for threshold_index, threshold in enumerate(thresholds):
            result = candidate_split(
                indexes,
                matrix,
                records,
                helpers,
                threshold,
                args,
                seed_material + threshold_index,
            )
            if result is not None:
                evaluated.append(result)
        node["split_diagnostics"] = [
            {key: value for key, value in result.items() if key not in {"groups", "residual_indexes"}}
            for result in evaluated
        ]
        accepted = [result for result in evaluated if result["accepted"]]
        if not accepted:
            node["stop_reason"] = "no_split_passed_quality_gates"
            split_diagnostics[node["stop_reason"]] += 1
            return
        chosen = max(accepted, key=lambda result: (result["score"], result["threshold"]))
        soft_groups = soft_memberships(
            indexes,
            chosen["groups"],
            matrix,
            chosen["threshold"],
            args.soft_membership_margin,
            args.max_soft_memberships,
        )
        node["chosen_split"] = {
            key: value for key, value in chosen.items() if key not in {"groups", "residual_indexes"}
        }
        node["residual_member_ids"] = sorted(records[index]["sample_id"] for index in chosen["residual_indexes"])
        for child_number, (hard_group, soft_group) in enumerate(
            zip(chosen["groups"], soft_groups, strict=True), start=1
        ):
            child_id = f"{node_id}.S{child_number:02d}"
            hard_ids = {records[index]["sample_id"] for index in hard_group}
            soft_ids = {records[index]["sample_id"] for index in soft_group}
            nodes[child_id] = {
                "node_id": child_id,
                "is_contained_by": [node_id],
                "soft_member_ids": sorted(soft_ids),
                "soft_additional_member_ids": sorted(soft_ids - hard_ids),
            }
            node["contains"].append(child_id)
            recurse(child_id, hard_group, depth + 1, member_ids)

    for cluster in cluster_payload["clusters"]:
        root_id = cluster["cluster_id"]
        indexes = [index_by_id[member["sample_id"]] for member in cluster["members"]]
        nodes[root_id] = {
            "node_id": root_id,
            "source_cluster_label": cluster["label"],
            "is_contained_by": [],
            "soft_member_ids": sorted(member["sample_id"] for member in cluster["members"]),
            "soft_additional_member_ids": [],
        }
        roots.append(root_id)
        recurse(root_id, indexes, 0, None)

    accepted_split_count = sum(bool(node.get("contains")) for node in nodes.values())
    validation = validate_hierarchy(nodes, roots, args.max_soft_memberships)
    payload = {
        "method": "downward recursive semantic refinement with structural rule probing",
        "precedence": "semantic nodes are primary; structural candidates are explanatory evidence",
        "parameters": {
            "max_depth": args.max_depth,
            "min_parent_size": args.min_parent_size,
            "min_child_size": args.min_child_size,
            "min_coverage": args.min_coverage,
            "min_cohesion_gain": args.min_cohesion_gain,
            "min_silhouette": args.min_silhouette,
            "min_stability": args.min_stability,
            "min_label_distinctness": args.min_label_distinctness,
            "soft_membership_margin": args.soft_membership_margin,
            "maximum_soft_memberships_per_split": args.max_soft_memberships,
            "stability_repeats": args.stability_repeats,
            "candidate_distance_thresholds": thresholds,
        },
        "root_count": len(roots),
        "node_count": len(nodes),
        "accepted_split_count": accepted_split_count,
        "maximum_observed_depth": max(node["depth"] for node in nodes.values()),
        "stop_reason_counts": dict(sorted(split_diagnostics.items())),
        "hierarchy_validation": validation,
        "roots": roots,
        "nodes": list(nodes.values()),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(
        f"Refined {len(roots)} semantic roots into {len(nodes)} nodes with "
        f"{accepted_split_count} accepted downward splits (max depth {payload['maximum_observed_depth']})"
    )


if __name__ == "__main__":
    main()

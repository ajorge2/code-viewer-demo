#!/usr/bin/env python3
"""Prototype the queue's per-base co-edit expansion with structural tree distance.

Until paired Semgrep rules exist, the gSpan host-graph set supplies D_base. The script
then resolves likely anchor components, extracts the other observed-file components,
and groups their abstract edit trees at a normalized TED similarity threshold.
"""

from __future__ import annotations

import argparse
from collections import Counter
from functools import lru_cache
import hashlib
import json
from pathlib import Path

import networkx as nx


Tree = tuple[str, tuple["Tree", ...]]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--patterns", type=Path, required=True)
    parser.add_argument("--graph-index", type=Path, required=True)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expansion-graphs", type=Path)
    parser.add_argument("--expansion-labels", type=Path)
    parser.add_argument("--expansion-index", type=Path)
    parser.add_argument(
        "--retrieval",
        choices=("host-set", "constraint", "exact-subgraph"),
        default="host-set",
        help="How to retrieve base occurrences in the expansion corpus",
    )
    parser.add_argument(
        "--coedit-unit",
        choices=("bundle", "component"),
        default="bundle",
        help="Cluster every adjacent component together or each component separately",
    )
    parser.add_argument(
        "--context-source",
        choices=("co-components", "within-component", "combined"),
        default="co-components",
        help="Which structural context to cluster around the popped base",
    )
    parser.add_argument("--similarity-threshold", type=float, default=0.75)
    parser.add_argument("--min-support", type=int, default=5)
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def read_gspan_graphs(path: Path, labels_path: Path) -> dict[int, nx.Graph]:
    labels = json.loads(labels_path.read_text(encoding="utf-8"))
    vertex_labels = labels["vertices"]
    edge_labels = labels["edges"]
    graphs: dict[int, nx.Graph] = {}
    current: nx.Graph | None = None
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        parts = raw_line.split()
        if not parts:
            continue
        if parts[0] == "t" and len(parts) >= 3:
            graph_id = int(parts[2])
            if graph_id < 0:
                current = None
                continue
            current = nx.Graph()
            graphs[graph_id] = current
        elif parts[0] == "v" and current is not None:
            current.add_node(int(parts[1]), label=vertex_labels[parts[2]])
        elif parts[0] == "e" and current is not None:
            current.add_edge(int(parts[1]), int(parts[2]), label=edge_labels[parts[3]])
    return graphs


def pattern_graph(pattern: dict) -> nx.Graph:
    graph = nx.Graph()
    for node in pattern["nodes"]:
        graph.add_node(int(node["id"]), label=node["label"])
    for edge in pattern["edges"]:
        graph.add_edge(int(edge["source"]), int(edge["target"]), label=edge["label"])
    return graph


def graph_label_profile(graph: nx.Graph) -> tuple[Counter[str], Counter[str]]:
    profile = graph.graph.get("label_profile")
    if profile is None:
        profile = (
            Counter(attributes["label"] for _, attributes in graph.nodes(data=True)),
            Counter(attributes["label"] for _, _, attributes in graph.edges(data=True)),
        )
        graph.graph["label_profile"] = profile
    return profile


def contains_pattern(host: nx.Graph, pattern: nx.Graph) -> bool:
    host_nodes, host_edges = graph_label_profile(host)
    pattern_nodes, pattern_edges = graph_label_profile(pattern)
    if any(host_nodes[label] < count for label, count in pattern_nodes.items()):
        return False
    if any(host_edges[label] < count for label, count in pattern_edges.items()):
        return False
    matcher = nx.algorithms.isomorphism.GraphMatcher(
        host,
        pattern,
        node_match=lambda left, right: left["label"] == right["label"],
        edge_match=lambda left, right: left["label"] == right["label"],
    )
    return matcher.subgraph_is_monomorphic()


def subtree_from_flat(nodes: list[dict]) -> Tree:
    if not nodes:
        return ("empty", ())
    by_parent: dict[int, list[dict]] = {}
    for node in nodes:
        by_parent.setdefault(int(node["parent"]), []).append(node)

    def build(node: dict) -> Tree:
        children = sorted(by_parent.get(int(node["id"]), []), key=lambda child: int(child.get("child_index", 0)))
        return (str(node["type"]), tuple(build(child) for child in children))

    roots = sorted(by_parent.get(-1, []), key=lambda node: int(node.get("child_index", 0)))
    if len(roots) == 1:
        return build(roots[0])
    return ("forest", tuple(build(root) for root in roots))


def component_tree(sample: dict, component: dict) -> Tree:
    children = []
    for action_index in component["action_indexes"]:
        action = sample["analysis"]["actions"][action_index]
        subtree = subtree_from_flat(action.get("subtree", []))
        children.append((f"action:{action['action']}", (subtree,)))
    return (f"component:{component['type']}", tuple(children))


def action_tree(action: dict) -> Tree:
    return (f"action:{action['action']}", (subtree_from_flat(action.get("subtree", [])),))


@lru_cache(maxsize=None)
def tree_size(tree: Tree) -> int:
    return 1 + sum(tree_size(child) for child in tree[1])


@lru_cache(maxsize=None)
def tree_label_profile(tree: Tree) -> Counter[str]:
    profile = Counter({tree[0]: 1})
    for child in tree[1]:
        profile.update(tree_label_profile(child))
    return profile


def label_edit_lower_bound(left: Tree, right: Tree) -> int:
    left_profile = tree_label_profile(left)
    right_profile = tree_label_profile(right)
    labels = left_profile.keys() | right_profile.keys()
    deletions = sum(max(left_profile[label] - right_profile[label], 0) for label in labels)
    insertions = sum(max(right_profile[label] - left_profile[label], 0) for label in labels)
    return max(deletions, insertions)


@lru_cache(maxsize=None)
def tree_distance(left: Tree, right: Tree) -> int:
    rename = 0 if left[0] == right[0] else 1
    left_children = left[1]
    right_children = right[1]
    rows = len(left_children) + 1
    cols = len(right_children) + 1
    dp = [[0] * cols for _ in range(rows)]
    for i in range(1, rows):
        dp[i][0] = dp[i - 1][0] + tree_size(left_children[i - 1])
    for j in range(1, cols):
        dp[0][j] = dp[0][j - 1] + tree_size(right_children[j - 1])
    for i in range(1, rows):
        for j in range(1, cols):
            dp[i][j] = min(
                dp[i - 1][j] + tree_size(left_children[i - 1]),
                dp[i][j - 1] + tree_size(right_children[j - 1]),
                dp[i - 1][j - 1] + tree_distance(left_children[i - 1], right_children[j - 1]),
            )
    return rename + dp[-1][-1]


def similarity(left: Tree, right: Tree) -> float:
    denominator = max(tree_size(left), tree_size(right), 1)
    return max(0.0, 1.0 - tree_distance(left, right) / denominator)


def base_constraints(pattern: dict) -> tuple[set[str], set[str]]:
    actions = set()
    node_types = set()
    for node in pattern["nodes"]:
        label = node["label"]
        if label.startswith("action:"):
            actions.add(label.removeprefix("action:"))
        elif label.startswith(("before:", "after:")):
            parts = label.split(":", 2)
            if len(parts) > 1 and parts[1] and parts[1] not in {",", ";", ":"}:
                node_types.add(parts[1])
    return actions, node_types


def action_types(action: dict) -> set[str]:
    return (
        {str(node["type"]) for node in action.get("subtree", [])}
        | {str(ancestor["type"]) for ancestor in action.get("node", {}).get("ancestors", [])}
        | {str(action.get("node", {}).get("type", ""))}
        | {str(action.get("parent", {}).get("type", ""))}
    )


def matching_action_indexes(sample: dict, pattern: dict) -> list[int]:
    wanted_actions, wanted_types = base_constraints(pattern)
    matches = []
    for component in sample["components"]:
        for action_index in component["action_indexes"]:
            action = sample["analysis"]["actions"][action_index]
            if wanted_actions and action["action"] not in wanted_actions:
                continue
            if wanted_types and not (wanted_types & action_types(action)):
                continue
            matches.append(action_index)
    return sorted(set(matches))


def anchor_components(sample: dict, pattern: dict) -> list[int]:
    matching_actions = set(matching_action_indexes(sample, pattern))
    matches = []
    for index, component in enumerate(sample["components"]):
        if matching_actions.intersection(component["action_indexes"]):
            matches.append(index)
    return matches


class UnionFind:
    def __init__(self, size: int) -> None:
        self.parent = list(range(size))

    def find(self, value: int) -> int:
        while self.parent[value] != value:
            self.parent[value] = self.parent[self.parent[value]]
            value = self.parent[value]
        return value

    def union(self, left: int, right: int) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root != right_root:
            self.parent[right_root] = left_root


def cluster_occurrences(occurrences: list[dict], threshold: float) -> list[list[int]]:
    tree_indexes: dict[Tree, list[int]] = {}
    for index, occurrence in enumerate(occurrences):
        tree_indexes.setdefault(occurrence["tree"], []).append(index)
    unique_trees = list(tree_indexes)
    union = UnionFind(len(unique_trees))
    sizes = [tree_size(tree) for tree in unique_trees]
    for left in range(len(unique_trees)):
        for right in range(left + 1, len(unique_trees)):
            if min(sizes[left], sizes[right]) / max(sizes[left], sizes[right]) < threshold:
                continue
            if 1 - label_edit_lower_bound(unique_trees[left], unique_trees[right]) / max(sizes[left], sizes[right]) < threshold:
                continue
            if similarity(unique_trees[left], unique_trees[right]) >= threshold:
                union.union(left, right)
    groups: dict[int, list[int]] = {}
    for tree_index, tree in enumerate(unique_trees):
        groups.setdefault(union.find(tree_index), []).extend(tree_indexes[tree])
    return list(groups.values())


def summarize_signature(tree: Tree) -> str:
    labels = []

    def visit(node: Tree) -> None:
        labels.append(node[0])
        for child in node[1]:
            visit(child)

    visit(tree)
    counts = Counter(labels)
    return " + ".join(f"{label}×{count}" if count > 1 else label for label, count in counts.most_common(8))


def deduplicate_composites(composites: list[dict], context_source: str) -> list[dict]:
    """Collapse the same observed context/host set emitted under multiple base anchors."""
    groups: dict[tuple[str, tuple[str, ...]], list[dict]] = {}
    for candidate in composites:
        key = (candidate["context_structure_hash"], tuple(candidate["sample_ids"]))
        groups.setdefault(key, []).append(candidate)

    merged = []
    prefix = context_source.replace("-", "_").upper()
    ordered_groups = sorted(
        groups.values(),
        key=lambda group: (-group[0]["commit_support"], group[0]["coedit_signature"]),
    )
    for index, group in enumerate(ordered_groups, start=1):
        representative = dict(group[0])
        base_ids = sorted({candidate["base_id"] for candidate in group})
        representative.update({
            "candidate_id": f"PILOT_{prefix}_COMPOSITE_{index:03d}",
            "base_id": base_ids[0] if len(base_ids) == 1 else None,
            "base_ids": base_ids,
            "contains": base_ids,
            "source_candidate_ids": sorted(candidate["candidate_id"] for candidate in group),
            "is_cross_anchor_intersection": len(base_ids) > 1,
        })
        merged.append(representative)
    return merged


def main() -> None:
    args = parse_args()
    patterns_payload = json.loads(args.patterns.read_text(encoding="utf-8"))
    graph_index = json.loads(args.graph_index.read_text(encoding="utf-8"))
    samples = {
        sample["sample_id"]: sample
        for sample in read_jsonl(args.samples)
        if sample.get("addition_dominant") and sample.get("analysis", {}).get("ok")
    }
    expansion_arguments = [args.expansion_graphs, args.expansion_labels, args.expansion_index]
    if args.retrieval == "exact-subgraph" and not all(expansion_arguments):
        raise ValueError("exact-subgraph retrieval requires all three expansion graph arguments")
    if any(expansion_arguments) and not all(expansion_arguments):
        raise ValueError("--expansion-graphs, --expansion-labels, and --expansion-index must be provided together")
    expansion_graphs = None
    expansion_index = None
    if args.retrieval == "exact-subgraph":
        expansion_graphs = read_gspan_graphs(args.expansion_graphs, args.expansion_labels)
        expansion_index = json.loads(args.expansion_index.read_text(encoding="utf-8"))
    bases = []
    composites = []

    for pattern in patterns_payload["patterns"]:
        base_id = f"PILOT_GSPAN_{pattern['id']:04d}"
        expected_queue_hosts = {
            graph_index[str(graph_id)] for graph_id in pattern["graph_ids"]
        }
        if args.retrieval == "host-set":
            sample_ids = sorted(expected_queue_hosts)
        elif args.retrieval == "constraint":
            sample_ids = list(samples)
        else:
            query = pattern_graph(pattern)
            sample_ids = [
                expansion_index[str(graph_id)]
                for graph_id, host in expansion_graphs.items()
                if contains_pattern(host, query)
            ]
        occurrences = []
        unresolved = 0
        no_adjacent = 0
        resolved_hosts = []
        for sample_id in sample_ids:
            sample = samples[sample_id]
            matched_action_indexes = matching_action_indexes(sample, pattern)
            anchors = anchor_components(sample, pattern)
            if not anchors:
                unresolved += 1
                continue
            resolved_hosts.append(sample_id)
            adjacent_indexes = [
                index for index in range(len(sample["components"])) if index not in anchors
            ]
            if not adjacent_indexes:
                no_adjacent += 1
            within_trees = tuple(
                action_tree(sample["analysis"]["actions"][action_index])
                for action_index in matched_action_indexes
            )
            adjacent_trees = tuple(
                component_tree(sample, sample["components"][component_index])
                for component_index in adjacent_indexes
            )
            if args.context_source == "within-component":
                context_tree = (f"within-component-context:{len(within_trees)}", within_trees)
                occurrences.append({
                    "sample_id": sample_id,
                    "tree": context_tree,
                    "added_component_count": 0,
                    "total_component_count": len(sample["components"]),
                    "context_node_count": tree_size(context_tree),
                })
            elif args.context_source == "combined":
                context_tree = (
                    "combined-context",
                    (
                        (f"anchor-actions:{len(within_trees)}", within_trees),
                        (f"coedit-bundle:{len(adjacent_trees)}", adjacent_trees),
                    ),
                )
                occurrences.append({
                    "sample_id": sample_id,
                    "tree": context_tree,
                    "added_component_count": len(adjacent_trees),
                    "total_component_count": len(sample["components"]),
                    "context_node_count": tree_size(context_tree),
                })
            elif args.coedit_unit == "bundle" and adjacent_trees:
                context_tree = (f"coedit-bundle:{len(adjacent_trees)}", adjacent_trees)
                occurrences.append({
                    "sample_id": sample_id,
                    "tree": context_tree,
                    "added_component_count": len(adjacent_trees),
                    "total_component_count": len(sample["components"]),
                    "context_node_count": tree_size(context_tree),
                })
            elif args.context_source == "co-components":
                for component_index in adjacent_indexes:
                    component = sample["components"][component_index]
                    context_tree = component_tree(sample, component)
                    occurrences.append({
                        "sample_id": sample_id,
                        "component_id": component["id"],
                        "tree": context_tree,
                        "added_component_count": 1,
                        "total_component_count": len(sample["components"]),
                        "context_node_count": tree_size(context_tree),
                    })

        resolved_queue_hosts = {
            sample_id for sample_id in resolved_hosts if samples[sample_id].get("eligible")
        }
        true_positive_hosts = expected_queue_hosts & resolved_queue_hosts
        retrieval_validation = {
            "expected_gspan_hosts": len(expected_queue_hosts),
            "predicted_queue_hosts": len(resolved_queue_hosts),
            "true_positive_hosts": len(true_positive_hosts),
            "precision": (
                len(true_positive_hosts) / len(resolved_queue_hosts)
                if resolved_queue_hosts else 0.0
            ),
            "recall": (
                len(true_positive_hosts) / len(expected_queue_hosts)
                if expected_queue_hosts else 0.0
            ),
        }

        base_summary = {
            "base_id": base_id,
            "base_support": pattern["support"],
            "expansion_host_support": len(resolved_hosts),
            "complex_expansion_hosts": sum(samples[sample_id]["component_count"] > 3 for sample_id in resolved_hosts),
            "resolved_multi_component_occurrences": len({item["sample_id"] for item in occurrences}),
            "hosts_without_adjacent_components": no_adjacent,
            "unresolved_anchor_hosts": unresolved,
            "queue_retrieval_validation": retrieval_validation,
            "candidate_count": 0,
        }
        if occurrences:
            groups = cluster_occurrences(occurrences, args.similarity_threshold)
            candidate_number = 0
            for group in groups:
                ids = sorted({occurrences[index]["sample_id"] for index in group})
                if len(ids) < args.min_support:
                    continue
                candidate_number += 1
                representative = occurrences[group[0]]["tree"]
                group_occurrences = [occurrences[index] for index in group]
                candidate = {
                    "candidate_id": f"{base_id}_COEDIT_{candidate_number:03d}",
                    "base_id": base_id,
                    "contains": [base_id],
                    "is_contained_by": [],
                    "commit_support": len(ids),
                    "independent_repository_support": None,
                    "mdl_compression_ratio": None,
                    "passes_commit_frequency": len(ids) >= 100,
                    "eligible_for_registration": False,
                    "registration_blockers": [
                        blocker
                        for blocker, blocked in [
                            ("commit_support_below_100", len(ids) < 100),
                            ("independent_repository_support_unmeasured", True),
                            ("mdl_unmeasured", True),
                        ]
                        if blocked
                    ],
                    "ted_similarity_threshold": args.similarity_threshold,
                    "coedit_unit": args.coedit_unit,
                    "context_source": args.context_source,
                    "maximum_added_components": max(item["added_component_count"] for item in group_occurrences),
                    "maximum_total_components": max(item["total_component_count"] for item in group_occurrences),
                    "minimum_context_nodes": min(item["context_node_count"] for item in group_occurrences),
                    "maximum_context_nodes": max(item["context_node_count"] for item in group_occurrences),
                    "context_structure_hash": hashlib.sha256(
                        repr(representative).encode("utf-8")
                    ).hexdigest(),
                    "coedit_signature": summarize_signature(representative),
                    "sample_ids": ids,
                }
                composites.append(candidate)
            base_summary["candidate_count"] = candidate_number
        bases.append(base_summary)

    composites.sort(key=lambda candidate: (-candidate["commit_support"], candidate["candidate_id"]))
    deduplicated_composites = deduplicate_composites(composites, args.context_source)
    validation_totals = {
        "expected_gspan_hosts": sum(
            base["queue_retrieval_validation"]["expected_gspan_hosts"] for base in bases
        ),
        "predicted_queue_hosts": sum(
            base["queue_retrieval_validation"]["predicted_queue_hosts"] for base in bases
        ),
        "true_positive_hosts": sum(
            base["queue_retrieval_validation"]["true_positive_hosts"] for base in bases
        ),
    }
    validation_totals["micro_precision"] = (
        validation_totals["true_positive_hosts"] / validation_totals["predicted_queue_hosts"]
        if validation_totals["predicted_queue_hosts"] else 0.0
    )
    validation_totals["micro_recall"] = (
        validation_totals["true_positive_hosts"] / validation_totals["expected_gspan_hosts"]
        if validation_totals["expected_gspan_hosts"] else 0.0
    )
    payload = {
        "method": "base subgraph retrieval + anchor resolution + normalized ordered TED grouping",
        "retrieval_scope": {
            "host-set": "original gSpan host graph sets",
            "constraint": "addition-dominant expansion corpus without a component-count ceiling, using action/type constraints",
            "exact-subgraph": "addition-dominant expansion corpus without a component-count ceiling, using labeled subgraph matching",
        }[args.retrieval],
        "retrieval_method": args.retrieval,
        "semgrep_status": "retrieval remains provisional until paired before/after Semgrep rules are compiled",
        "coedit_unit": args.coedit_unit,
        "context_source": args.context_source,
        "similarity_threshold": args.similarity_threshold,
        "minimum_exploratory_support": args.min_support,
        "base_count": len(bases),
        "raw_composite_candidate_count": len(composites),
        "composite_candidate_count": len(deduplicated_composites),
        "exact_duplicate_candidate_count": len(composites) - len(deduplicated_composites),
        "cross_anchor_intersection_count": sum(
            candidate["is_cross_anchor_intersection"] for candidate in deduplicated_composites
        ),
        "commit_frequency_pass_count": sum(
            candidate["passes_commit_frequency"] for candidate in deduplicated_composites
        ),
        "registered_count": 0,
        "retrieval_validation_against_queue_gspan_hosts": validation_totals,
        "bases": bases,
        "composites": deduplicated_composites,
        "raw_composites": composites,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(
        f"Expanded {len(bases)} bases into {len(deduplicated_composites)} unique "
        f"{args.context_source} candidates ({len(composites)} before exact deduplication); "
        f"{payload['commit_frequency_pass_count']} pass commit frequency and 0 are registrable before provenance/MDL"
    )


if __name__ == "__main__":
    main()

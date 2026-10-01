#!/usr/bin/env python3
"""Mine frequent pilot change-graph fragments with a pinned gSpan backend."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import time
from collections import defaultdict
from pathlib import Path

import networkx as nx
from submine.algorithms import gspan_cpp


def is_complete_change_fragment(nodes: list[dict], edges: list[dict]) -> bool:
    """Reject dangling relation fragments and syntax-only motifs."""
    labels_by_id = {node["id"]: node["label"] for node in nodes}
    labels = list(labels_by_id.values())
    if not any(label.startswith("action:") for label in labels):
        return False
    if not any(label.startswith(("before:", "after:")) for label in labels):
        return False

    incident: dict[int, list[str]] = {node["id"]: [] for node in nodes}
    for edge in edges:
        incident[edge["source"]].append(edge["label"])
        incident[edge["target"]].append(edge["label"])
    for node_id, label in labels_by_id.items():
        if label.startswith("relation:") and sorted(incident[node_id]) != ["source", "target"]:
            return False
    return True


def as_networkx(pattern: dict) -> nx.Graph:
    graph = nx.Graph()
    for node in pattern["nodes"]:
        graph.add_node(node["id"], label=node["label"])
    for edge in pattern["edges"]:
        graph.add_edge(edge["source"], edge["target"], label=edge["label"])
    return graph


def support_closed_patterns(patterns: list[dict]) -> list[dict]:
    """Keep patterns with no strictly larger supergraph on the same host set."""
    groups: dict[tuple[int, ...], list[dict]] = defaultdict(list)
    for pattern in patterns:
        groups[tuple(pattern["graph_ids"])].append(pattern)

    kept = []
    for group in groups.values():
        ordered = sorted(
            group,
            key=lambda item: (-item["num_vertices"], -item["num_edges"], item["id"]),
        )
        graphs = {item["id"]: as_networkx(item) for item in ordered}
        for candidate in ordered:
            candidate_graph = graphs[candidate["id"]]
            dominated = False
            for larger in kept:
                if larger["graph_ids"] != candidate["graph_ids"]:
                    continue
                if larger["num_vertices"] <= candidate["num_vertices"]:
                    continue
                matcher = nx.algorithms.isomorphism.GraphMatcher(
                    graphs[larger["id"]],
                    candidate_graph,
                    node_match=lambda left, right: left["label"] == right["label"],
                    edge_match=lambda left, right: left["label"] == right["label"],
                )
                if matcher.subgraph_is_monomorphic():
                    dominated = True
                    break
            if not dominated:
                kept.append(candidate)
    return kept


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--data",
        type=Path,
        default=root / ".data/intent-pilot/eligible-change-graphs.data",
    )
    parser.add_argument(
        "--labels",
        type=Path,
        default=root / ".data/intent-pilot/gspan-labels.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=root / ".data/intent-pilot/mined-patterns.json",
    )
    parser.add_argument(
        "--graph-index",
        type=Path,
        default=root / ".data/intent-pilot/graph-index.json",
    )
    parser.add_argument("--min-support", type=int, default=5)
    parser.add_argument("--min-vertices", type=int, default=3)
    parser.add_argument("--max-vertices", type=int, default=6)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    labels = json.loads(args.labels.read_text())
    graph_index = json.loads(args.graph_index.read_text())
    vertex_labels = labels["vertices"]
    edge_labels = labels["edges"]

    started = time.perf_counter()
    records = gspan_cpp.mine_from_string(
        args.data.read_text(),
        minsup=args.min_support,
        directed=False,
        maxpat_min=args.min_vertices,
        maxpat_max=args.max_vertices,
    )
    runtime = time.perf_counter() - started

    patterns = []
    for pattern_id, record in enumerate(records):
        nodes = [
            {
                "id": node,
                "label_id": label_id,
                "label": vertex_labels.get(str(label_id), "<unknown>"),
            }
            for node, label_id in zip(record["nodes"], record["node_labels"], strict=True)
        ]
        edges = []
        seen_edges = set()
        for (source, target), label_id in zip(
            record["edges"], record["edge_labels"], strict=True
        ):
            edge_key = (min(source, target), max(source, target), label_id)
            if edge_key in seen_edges:
                continue
            seen_edges.add(edge_key)
            edges.append(
                {
                    "source": source,
                    "target": target,
                    "label_id": label_id,
                    "label": edge_labels.get(str(label_id), "<unknown>"),
                }
            )
        pattern = {
                "id": pattern_id,
                "support": record["support"],
                "num_vertices": len(nodes),
                "num_edges": len(edges),
                "graph_ids": record["graph_ids"],
                "sample_ids": [
                    graph_index.get(str(graph_id), f"<unknown:{graph_id}>")
                    for graph_id in record["graph_ids"]
                ],
                "nodes": nodes,
                "edges": edges,
            }
        if is_complete_change_fragment(nodes, edges):
            patterns.append(pattern)

    structurally_valid_count = len(patterns)
    patterns = support_closed_patterns(patterns)
    patterns.sort(key=lambda item: (-item["support"], -item["num_vertices"], item["id"]))
    payload = {
        "tool": "submine",
        "tool_version": importlib.metadata.version("submine"),
        "algorithm": "gspan",
        "parameters": {
            "min_support": args.min_support,
            "min_vertices": args.min_vertices,
            "max_vertices": args.max_vertices,
            "directed": False,
            "direction_encoding": "relation vertices with source/target edges",
        },
        "runtime_seconds": runtime,
        "raw_pattern_count": len(records),
        "structurally_valid_pattern_count": structurally_valid_count,
        "pattern_count": len(patterns),
        "postfilter": [
            "complete relation vertices plus at least one action and one AST node",
            "support-closed: no larger labeled supergraph with the same host graph set",
        ],
        "patterns": patterns,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n")
    print(
        f"Mined {len(patterns)} patterns in {runtime:.3f}s; "
        f"wrote {args.output}"
    )


if __name__ == "__main__":
    main()

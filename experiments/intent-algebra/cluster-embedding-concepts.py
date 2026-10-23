#!/usr/bin/env python3
"""Cluster broad code-change concepts with OpenAI embeddings.

This is an auxiliary semantic exploration layer. It does not replace the
Semgrep -> TED -> gSpan expansion used to discover structural primitives.
"""

from __future__ import annotations

import argparse
from collections import Counter
from hashlib import sha256
from html import escape
import json
import os
from pathlib import Path
import re

import numpy as np
from openai import OpenAI
from sklearn import __version__ as sklearn_version
from sklearn.cluster import AgglomerativeClustering
from sklearn.metrics import pairwise_distances, silhouette_score


GENERIC_LABEL_TOKENS = {
    "add", "allow", "already", "app", "array", "assert", "change", "class",
    "clean", "component", "components", "data", "default", "enable", "field",
    "file", "files", "find", "fix", "function", "global", "id", "improve",
    "init", "insert", "item", "make", "max", "method", "module", "modules",
    "name", "new", "object", "option", "public", "remove", "script", "scripts",
    "self", "set", "setup", "support", "text", "update", "use", "value",
}

NORMALIZE = {
    "caches": "cache",
    "dependencies": "dependency",
    "dependents": "dependency",
    "databases": "database",
    "models": "model",
    "settings": "setting",
    "urls": "url",
    "users": "user",
}


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        type=Path,
        default=root / ".data/intent-pilot-additive/edit-facets.jsonl",
    )
    parser.add_argument(
        "--samples",
        type=Path,
        default=root / ".data/intent-pilot-additive/sample-results.jsonl",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=root / ".data/intent-pilot-additive/embedding-concept-clusters.json",
    )
    parser.add_argument(
        "--cache",
        type=Path,
        default=root / ".data/intent-pilot-additive/openai-embedding-cache.json",
    )
    parser.add_argument(
        "--figure",
        type=Path,
        default=root / "docs/figures/intent-algebra-additive/06-embedding-concept-clusters.svg",
    )
    parser.add_argument("--model", default="text-embedding-3-small")
    parser.add_argument("--dimensions", type=int, default=512)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--distance-threshold", type=float, default=0.30)
    parser.add_argument("--min-cluster-size", type=int, default=2)
    parser.add_argument(
        "--parent-distance-threshold",
        type=float,
        default=0.38,
        help="Cosine-distance ceiling when recursively grouping concept clusters",
    )
    parser.add_argument(
        "--max-hierarchy-levels",
        type=int,
        default=3,
        help="Maximum number of cluster-of-clusters passes",
    )
    parser.add_argument("--offline", action="store_true", help="Fail instead of requesting missing embeddings")
    return parser.parse_args()


def load_project_env(path: Path) -> None:
    """Load missing values from a simple dotenv file without logging secrets."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def compact_excerpt(value: str, max_chars: int = 1_800) -> str:
    """Deduplicate the pilot's overlapping excerpt windows and bound API input."""
    segments: list[str] = []
    seen: set[str] = set()
    for segment in value.split("\n---\n"):
        normalized = re.sub(r"[ \t]+", " ", segment.strip())
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        segments.append(normalized)
    return "\n---\n".join(segments)[:max_chars]


def embedding_text(record: dict, sample: dict) -> str:
    sources = record["concept_tokens"]
    changed_terms = " ".join(dict.fromkeys(sources["changed_code"]))
    path_terms = " ".join(dict.fromkeys(sources["file_path"]))
    containers = ", ".join(container["name"] for container in record["containers"]) or "none"
    operations = ", ".join(record["operations"])
    return "\n".join([
        "Represent the broad software concepts involved in this code change.",
        f"Language: {record['language']}",
        f"File path: {record['file']}",
        f"Path concepts: {path_terms}",
        f"Commit subject: {record['subject']}",
        f"AST edit: {operations} {record['primary_entity_name']}; containers: {containers}",
        f"Changed identifiers and literals: {changed_terms}",
        "Before code:",
        compact_excerpt(sample.get("before_excerpt", "")),
        "After code:",
        compact_excerpt(sample.get("after_excerpt", "")),
    ])


def cache_key(model: str, dimensions: int, text: str) -> str:
    material = json.dumps(
        {"model": model, "dimensions": dimensions, "text": text},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return sha256(material.encode("utf-8")).hexdigest()


def load_cache(path: Path, model: str, dimensions: int) -> dict:
    empty = {
        "schema_version": 1,
        "model": model,
        "dimensions": dimensions,
        "embeddings": {},
    }
    if not path.exists():
        return empty
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("model") != model or payload.get("dimensions") != dimensions:
        return empty
    if not isinstance(payload.get("embeddings"), dict):
        raise ValueError(f"Invalid embedding cache: {path}")
    return payload


def embed_texts(
    texts: list[str],
    *,
    model: str,
    dimensions: int,
    batch_size: int,
    cache_path: Path,
    offline: bool,
) -> tuple[np.ndarray, int]:
    cache = load_cache(cache_path, model, dimensions)
    keys = [cache_key(model, dimensions, text) for text in texts]
    missing_indexes = [index for index, key in enumerate(keys) if key not in cache["embeddings"]]
    requested = 0
    if missing_indexes:
        if offline:
            raise RuntimeError(f"Embedding cache is missing {len(missing_indexes)} records in offline mode")
        if not os.environ.get("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY is not configured")
        client = OpenAI()
        for start in range(0, len(missing_indexes), batch_size):
            indexes = missing_indexes[start:start + batch_size]
            response = client.embeddings.create(
                model=model,
                dimensions=dimensions,
                encoding_format="float",
                input=[texts[index] for index in indexes],
            )
            if len(response.data) != len(indexes):
                raise RuntimeError("Embedding API returned an unexpected number of vectors")
            for index, item in zip(indexes, sorted(response.data, key=lambda value: value.index), strict=True):
                cache["embeddings"][keys[index]] = item.embedding
            requested += len(indexes)
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps(cache, separators=(",", ":")) + "\n", encoding="utf-8")
    matrix = np.asarray([cache["embeddings"][key] for key in keys], dtype=np.float64)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    if np.any(norms == 0):
        raise RuntimeError("Embedding API returned a zero vector")
    return matrix / norms, requested


def fit_labels(matrix: np.ndarray, threshold: float) -> np.ndarray:
    model = AgglomerativeClustering(
        n_clusters=None,
        metric="cosine",
        linkage="average",
        distance_threshold=threshold,
    )
    return model.fit_predict(matrix)


def threshold_diagnostics(matrix: np.ndarray, selected: float) -> list[dict]:
    thresholds = sorted({round(value, 2) for value in np.arange(0.20, 0.51, 0.05)} | {selected})
    diagnostics = []
    for threshold in thresholds:
        labels = fit_labels(matrix, threshold)
        sizes = Counter(int(label) for label in labels)
        cluster_count = len(sizes)
        multi_record = sum(size >= 2 for size in sizes.values())
        covered = sum(size for size in sizes.values() if size >= 2)
        silhouette = None
        if 1 < cluster_count < len(matrix):
            silhouette = round(float(silhouette_score(matrix, labels, metric="cosine")), 6)
        diagnostics.append({
            "distance_threshold": threshold,
            "cluster_count_including_singletons": cluster_count,
            "multi_record_cluster_count": multi_record,
            "records_in_multi_record_clusters": covered,
            "silhouette": silhouette,
        })
    return diagnostics


def label_tokens(records: list[dict]) -> list[dict]:
    counts: Counter[str] = Counter()
    for record in records:
        sources = record["concept_tokens"]
        tokens = sources["changed_code"] * 3 + sources["file_path"] * 2 + sources["commit_subject"]
        for token in tokens:
            normalized = NORMALIZE.get(token, token)
            if len(normalized) > 2 and normalized not in GENERIC_LABEL_TOKENS:
                counts[normalized] += 1
    return [{"term": term, "weight": weight} for term, weight in counts.most_common(10)]


def noun_label(terms: list[dict]) -> str:
    return " · ".join(term["term"] for term in terms[:3]) or "unlabeled concept"


def repository_names(sample: dict) -> list[str]:
    return sorted({
        name.strip()
        for name in str(sample.get("repos", "")).split(",")
        if name.strip()
    })


def orthogonal_signature(record: dict) -> dict:
    operations = record["operations"] or ["other"]
    containers = [container["name"] for container in record["containers"]] or ["file"]
    return {
        "operations": operations,
        "entity": record["primary_entity_name"],
        "containers": containers,
        "display": (
            f"{' + '.join(operations)} → {record['primary_entity_name']} → "
            f"{' › '.join(containers)}"
        ),
    }


def relationship_patterns(records: list[dict]) -> list[dict]:
    """Aggregate pairwise orthogonal links with code provenance."""
    patterns: dict[str, dict] = {}
    for record in records:
        signature = orthogonal_signature(record)
        links = []
        for operation in signature["operations"]:
            links.append(("operation_entity", "operation", operation, "entity", signature["entity"]))
            for container in signature["containers"]:
                links.append(("operation_container", "operation", operation, "container", container))
        for container in signature["containers"]:
            links.append(("entity_container", "entity", signature["entity"], "container", container))
        for relation, left_axis, left_value, right_axis, right_value in set(links):
            key = json.dumps([relation, left_value, right_value], separators=(",", ":"))
            pattern = patterns.setdefault(key, {
                "relation": relation,
                "left": {"axis": left_axis, "value": left_value},
                "right": {"axis": right_axis, "value": right_value},
                "display": f"{left_value} ↔ {right_value}",
                "support": 0,
                "sample_ids": [],
            })
            pattern["support"] += 1
            pattern["sample_ids"].append(record["sample_id"])
    return sorted(
        patterns.values(),
        key=lambda pattern: (-pattern["support"], pattern["relation"], pattern["display"]),
    )


def summarize_clusters(
    records: list[dict], matrix: np.ndarray, labels: np.ndarray, min_cluster_size: int
) -> tuple[list[dict], list[dict]]:
    distances = pairwise_distances(matrix, metric="cosine")
    groups: dict[int, list[int]] = {}
    for index, label in enumerate(labels):
        groups.setdefault(int(label), []).append(index)

    clusters = []
    singletons = []
    for indexes in groups.values():
        if len(indexes) < min_cluster_size:
            singletons.extend({
                "sample_id": records[index]["sample_id"],
                "subject": records[index]["subject"],
                "file": records[index]["file"],
            } for index in indexes)
            continue
        subdistances = distances[np.ix_(indexes, indexes)]
        similarities = 1 - subdistances
        average_similarity = similarities.mean(axis=1)
        ranked = [indexes[position] for position in np.argsort(-average_similarity)]
        pair_values = similarities[np.triu_indices(len(indexes), k=1)]
        cluster_records = [records[index] for index in indexes]
        repositories = sorted({
            repository
            for record in cluster_records
            for repository in record.get("repositories", [])
        })
        terms = label_tokens(cluster_records)
        clusters.append({
            "label": noun_label(terms),
            "support": len(indexes),
            "repository_name_upper_bound": len(repositories),
            "repository_names": repositories,
            "mean_pairwise_cosine_similarity": round(float(pair_values.mean()), 6),
            "minimum_pairwise_cosine_similarity": round(float(pair_values.min()), 6),
            "medoid_sample_id": records[ranked[0]]["sample_id"],
            "terms": terms,
            "orthogonal_relationships": relationship_patterns(cluster_records),
            "members": [{
                "sample_id": records[index]["sample_id"],
                "subject": records[index]["subject"],
                "file": records[index]["file"],
                "repository_names": records[index].get("repositories", []),
                "primary_entity": records[index]["primary_entity_name"],
                "orthogonal_signature": orthogonal_signature(records[index]),
                "similarity_to_cluster_medoid": round(float(similarities[indexes.index(index), indexes.index(ranked[0])]), 6),
            } for index in ranked],
        })
    clusters.sort(key=lambda cluster: (-cluster["support"], -cluster["mean_pairwise_cosine_similarity"], cluster["label"]))
    for number, cluster in enumerate(clusters, start=1):
        cluster["cluster_id"] = f"EMBED_CONCEPT_{number:04d}"
    singletons.sort(key=lambda record: record["sample_id"])
    return clusters, singletons


def unit_centroid(matrix: np.ndarray) -> np.ndarray:
    centroid = matrix.mean(axis=0)
    norm = np.linalg.norm(centroid)
    if norm == 0:
        raise RuntimeError("Cannot normalize a zero cluster centroid")
    return centroid / norm


def recursive_cluster_hierarchy(
    clusters: list[dict],
    records: list[dict],
    matrix: np.ndarray,
    *,
    distance_threshold: float,
    max_levels: int,
) -> dict:
    """Re-cluster leaf-cluster centroids while retaining code provenance."""
    if not clusters:
        return {
            "method": "recursive centroid clustering",
            "distance_threshold": distance_threshold,
            "max_levels": max_levels,
            "levels": [],
            "roots": [],
        }

    record_by_id = {record["sample_id"]: record for record in records}
    index_by_id = {record["sample_id"]: index for index, record in enumerate(records)}
    exported_by_id: dict[str, dict] = {}
    active = []
    for cluster in clusters:
        sample_ids = [member["sample_id"] for member in cluster["members"]]
        indexes = [index_by_id[sample_id] for sample_id in sample_ids]
        cluster.setdefault("contains", [])
        cluster.setdefault("is_contained_by", [])
        exported_by_id[cluster["cluster_id"]] = cluster
        active.append({
            "cluster_id": cluster["cluster_id"],
            "sample_ids": sample_ids,
            "vector": unit_centroid(matrix[indexes]),
        })

    levels = []
    for level_number in range(1, max_levels + 1):
        if len(active) < 2:
            break
        active_matrix = np.asarray([node["vector"] for node in active])
        labels = fit_labels(active_matrix, distance_threshold)
        groups: dict[int, list[int]] = {}
        for index, label in enumerate(labels):
            groups.setdefault(int(label), []).append(index)

        drafts = []
        carried = []
        for indexes in groups.values():
            if len(indexes) == 1:
                carried.append(active[indexes[0]])
                continue
            child_nodes = [active[index] for index in indexes]
            child_matrix = active_matrix[indexes]
            similarities = 1 - pairwise_distances(child_matrix, metric="cosine")
            pair_values = similarities[np.triu_indices(len(indexes), k=1)]
            sample_ids = sorted({
                sample_id
                for child in child_nodes
                for sample_id in child["sample_ids"]
            })
            terms = label_tokens([record_by_id[sample_id] for sample_id in sample_ids])
            repositories = sorted({
                repository
                for sample_id in sample_ids
                for repository in record_by_id[sample_id].get("repositories", [])
            })
            drafts.append({
                "label": noun_label(terms),
                "support": len(sample_ids),
                "repository_name_upper_bound": len(repositories),
                "repository_names": repositories,
                "child_count": len(child_nodes),
                "contains": sorted(child["cluster_id"] for child in child_nodes),
                "is_contained_by": [],
                "sample_ids": sample_ids,
                "terms": terms,
                "mean_child_centroid_cosine_similarity": round(float(pair_values.mean()), 6),
                "minimum_child_centroid_cosine_similarity": round(float(pair_values.min()), 6),
                "vector": unit_centroid(child_matrix),
            })

        if not drafts:
            break
        drafts.sort(key=lambda node: (-node["support"], node["label"], node["contains"]))
        parents = []
        next_active = list(carried)
        for number, draft in enumerate(drafts, start=1):
            cluster_id = f"MACRO_L{level_number}_{number:04d}"
            vector = draft.pop("vector")
            exported = {"cluster_id": cluster_id, **draft}
            for child_id in exported["contains"]:
                exported_by_id[child_id]["is_contained_by"].append(cluster_id)
            exported_by_id[cluster_id] = exported
            parents.append(exported)
            next_active.append({
                "cluster_id": cluster_id,
                "sample_ids": exported["sample_ids"],
                "vector": vector,
            })
        levels.append({"level": level_number, "clusters": parents})
        active = next_active

    return {
        "method": "recursive centroid clustering with cosine average linkage",
        "distance_threshold": distance_threshold,
        "max_levels": max_levels,
        "levels": levels,
        "roots": sorted(node["cluster_id"] for node in active),
    }


def svg_figure(clusters: list[dict], path: Path, record_count: int, threshold: float) -> None:
    shown = clusters[:12]
    width = 1500
    row_height = 98
    height = 170 + row_height * max(len(shown), 1) + 82
    colors = ["#2563eb", "#7c3aed", "#138a72", "#d97706", "#d94f70", "#58748f"]
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        '<style>text{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.title{font-size:31px;font-weight:700;fill:#172033}.sub{font-size:17px;fill:#667085}.label{font-size:18px;font-weight:700;fill:#172033}.term{font-size:15px;fill:#344054}.note{font-size:14px;fill:#667085}</style>',
        '<text x="70" y="60" class="title">Embedding-based macro-concept clusters</text>',
        f'<text x="70" y="93" class="sub">OpenAI embeddings + cosine average-linkage over {record_count} addition-dominant changes (distance ≤ {threshold:.2f})</text>',
        '<text x="70" y="121" class="note">Auxiliary semantic annotations—not TED/gSpan structural primitives</text>',
    ]
    if not shown:
        parts.append('<text x="70" y="180" class="label">No multi-record clusters at this threshold.</text>')
    for index, cluster in enumerate(shown):
        color = colors[index % len(colors)]
        y = 158 + index * row_height
        label = escape(cluster["label"])
        parts.append(f'<text x="70" y="{y + 23}" class="label">{index + 1}. {label}</text>')
        parts.append(f'<text x="70" y="{y + 48}" class="note">{cluster["support"]} changes · mean cosine {cluster["mean_pairwise_cosine_similarity"]:.2f}</text>')
        x = 500
        max_weight = max((term["weight"] for term in cluster["terms"][:6]), default=1)
        for term in cluster["terms"][:6]:
            bar = 100 * term["weight"] / max_weight
            parts.append(f'<rect x="{x}" y="{y + 6}" width="{bar:.1f}" height="18" rx="4" fill="{color}" opacity="0.82"/>')
            parts.append(f'<text x="{x}" y="{y + 48}" class="term">{escape(term["term"])}</text>')
            x += 155
        parts.append(f'<line x1="70" y1="{y + 73}" x2="1430" y2="{y + 73}" stroke="#e3e7ee"/>')
    parts.append(f'<text x="70" y="{height - 34}" class="note">Labels are recurrent noun-like tokens; inspect member diffs before treating a cluster as coherent.</text>')
    parts.append("</svg>")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(parts) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    project_root = Path(__file__).resolve().parents[2]
    load_project_env(project_root / ".env")

    records = read_jsonl(args.input)
    wanted_ids = {record["sample_id"] for record in records}
    samples = {
        sample["sample_id"]: sample
        for sample in read_jsonl(args.samples)
        if sample.get("sample_id") in wanted_ids
    }
    missing_samples = sorted(wanted_ids - samples.keys())
    if missing_samples:
        raise ValueError(f"Missing sample evidence for {len(missing_samples)} faceted records")

    for record in records:
        record["repositories"] = repository_names(samples[record["sample_id"]])

    texts = [embedding_text(record, samples[record["sample_id"]]) for record in records]
    matrix, requested = embed_texts(
        texts,
        model=args.model,
        dimensions=args.dimensions,
        batch_size=args.batch_size,
        cache_path=args.cache,
        offline=args.offline,
    )
    labels = fit_labels(matrix, args.distance_threshold)
    clusters, singletons = summarize_clusters(records, matrix, labels, args.min_cluster_size)
    hierarchy = recursive_cluster_hierarchy(
        clusters,
        records,
        matrix,
        distance_threshold=args.parent_distance_threshold,
        max_levels=args.max_hierarchy_levels,
    )
    diagnostics = threshold_diagnostics(matrix, args.distance_threshold)

    payload = {
        "method": "OpenAI embeddings + cosine average-linkage agglomerative clustering",
        "role": "Auxiliary broad-concept annotations; not Semgrep/TED/gSpan structural primitives.",
        "model": args.model,
        "dimensions": args.dimensions,
        "library_versions": {
            "numpy": np.__version__,
            "openai": __import__("openai").__version__,
            "scikit_learn": sklearn_version,
        },
        "parameters": {
            "distance_threshold": args.distance_threshold,
            "linkage": "average",
            "metric": "cosine",
            "min_cluster_size": args.min_cluster_size,
            "parent_distance_threshold": args.parent_distance_threshold,
            "max_hierarchy_levels": args.max_hierarchy_levels,
        },
        "records": len(records),
        "new_embeddings_requested": requested,
        "cache_path": str(args.cache),
        "multi_record_cluster_count": len(clusters),
        "clustered_record_count": sum(cluster["support"] for cluster in clusters),
        "singleton_record_count": len(singletons),
        "threshold_diagnostics": diagnostics,
        "clusters": clusters,
        "hierarchy": hierarchy,
        "singletons": singletons,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    svg_figure(clusters, args.figure, len(records), args.distance_threshold)
    print(
        f"Wrote {len(clusters)} multi-record embedding clusters "
        f"({payload['clustered_record_count']}/{len(records)} records) to {args.output}; "
        f"requested {requested} new embeddings"
    )


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Cluster function units using only code-grounded semantic descriptions."""

from __future__ import annotations

import argparse
from collections import Counter
from hashlib import sha256
import json
import os
from pathlib import Path

import numpy as np
from openai import OpenAI
from sklearn.cluster import HDBSCAN
from sklearn.metrics import silhouette_score


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--embedding-cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--embedding-model", default="text-embedding-3-small")
    parser.add_argument("--dimensions", type=int, default=512)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--offline", action="store_true")
    return parser.parse_args()


def load_project_env(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def cache_key(model: str, dimensions: int, text: str) -> str:
    material = json.dumps(
        {"model": model, "dimensions": dimensions, "text": text},
        sort_keys=True,
        separators=(",", ":"),
    )
    return sha256(material.encode("utf-8")).hexdigest()


def embed_texts(texts: list[str], args: argparse.Namespace) -> tuple[np.ndarray, int]:
    cache = (
        json.loads(args.embedding_cache.read_text(encoding="utf-8"))
        if args.embedding_cache.exists()
        else {
            "schema_version": 1,
            "model": args.embedding_model,
            "dimensions": args.dimensions,
            "embeddings": {},
        }
    )
    if cache.get("model") != args.embedding_model or cache.get("dimensions") != args.dimensions:
        cache = {
            "schema_version": 1,
            "model": args.embedding_model,
            "dimensions": args.dimensions,
            "embeddings": {},
        }
    keys = [cache_key(args.embedding_model, args.dimensions, text) for text in texts]
    missing = [index for index, key in enumerate(keys) if key not in cache["embeddings"]]
    requested = 0
    if missing:
        if args.offline:
            raise RuntimeError(f"Embedding cache is missing {len(missing)} semantic descriptions")
        client = OpenAI()
        for start in range(0, len(missing), args.batch_size):
            indexes = missing[start:start + args.batch_size]
            response = client.embeddings.create(
                model=args.embedding_model,
                dimensions=args.dimensions,
                encoding_format="float",
                input=[texts[index] for index in indexes],
            )
            for index, item in zip(indexes, sorted(response.data, key=lambda value: value.index), strict=True):
                cache["embeddings"][keys[index]] = item.embedding
            requested += len(indexes)
            args.embedding_cache.parent.mkdir(parents=True, exist_ok=True)
            args.embedding_cache.write_text(json.dumps(cache, separators=(",", ":")) + "\n", encoding="utf-8")
    matrix = np.asarray([cache["embeddings"][key] for key in keys], dtype=np.float64)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    if np.any(norms == 0):
        raise RuntimeError("Embedding cache contains a zero vector")
    return matrix / norms, requested


def fit_configuration(matrix: np.ndarray, min_cluster_size: int, min_samples: int) -> tuple[np.ndarray, dict]:
    # Euclidean distance on unit-normalized vectors is monotonic with cosine distance.
    model = HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=min_samples,
        metric="euclidean",
        cluster_selection_method="eom",
        allow_single_cluster=False,
        store_centers="centroid",
        copy=True,
    )
    labels = model.fit_predict(matrix)
    assigned = labels >= 0
    cluster_ids = sorted(set(int(label) for label in labels if label >= 0))
    coverage = float(np.mean(assigned))
    silhouette = None
    if len(cluster_ids) >= 2 and int(np.sum(assigned)) > len(cluster_ids):
        silhouette = float(silhouette_score(matrix[assigned], labels[assigned], metric="cosine"))
    sizes = Counter(int(label) for label in labels if label >= 0)
    # Prefer coherent solutions while preserving a substantial explicit residual set.
    coherence = silhouette if silhouette is not None else -1.0
    coverage_target_penalty = abs(coverage - 0.60) * 0.20
    fragmentation_penalty = max(0, len(cluster_ids) - 20) * 0.01
    score = coherence - coverage_target_penalty - fragmentation_penalty
    return labels, {
        "min_cluster_size": min_cluster_size,
        "min_samples": min_samples,
        "cluster_count": len(cluster_ids),
        "assigned_count": int(np.sum(assigned)),
        "residual_count": int(np.sum(~assigned)),
        "coverage": round(coverage, 6),
        "silhouette_assigned": None if silhouette is None else round(silhouette, 6),
        "minimum_cluster_size_observed": min(sizes.values()) if sizes else 0,
        "maximum_cluster_size_observed": max(sizes.values()) if sizes else 0,
        "selection_score": round(score, 6),
    }


def main() -> None:
    args = parse_args()
    load_project_env(Path(__file__).resolve().parents[2] / ".env")
    all_rows = read_jsonl(args.input)
    rows = [row for row in all_rows if not row["semantic_description"]["abstain"]]
    matrix, requested = embed_texts([row["semantic_text"] for row in rows], args)

    diagnostics = []
    fitted = []
    for min_cluster_size in [4, 5, 6, 8]:
        for min_samples in [2, 3, 4]:
            labels, diagnostic = fit_configuration(matrix, min_cluster_size, min_samples)
            diagnostics.append(diagnostic)
            fitted.append((labels, diagnostic))
    viable = [item for item in fitted if item[1]["cluster_count"] >= 2 and item[1]["coverage"] >= 0.25]
    if not viable:
        raise RuntimeError("No semantic-only HDBSCAN configuration produced at least two nontrivial clusters")
    labels, selected = max(viable, key=lambda item: item[1]["selection_score"])

    clusters = []
    for cluster_id in sorted(set(int(label) for label in labels if label >= 0)):
        indexes = [index for index, label in enumerate(labels) if int(label) == cluster_id]
        vectors = matrix[indexes]
        centroid = np.mean(vectors, axis=0)
        centroid /= np.linalg.norm(centroid)
        fits = vectors @ centroid
        members = []
        for index, fit in sorted(zip(indexes, fits, strict=True), key=lambda pair: -pair[1]):
            row = rows[index]
            members.append({
                "sample_id": row["sample_id"],
                "purpose": row["semantic_description"]["purpose"],
                "semantic_text": row["semantic_text"],
                "centroid_fit": round(float(fit), 6),
                "language": row["language"],
                "repository_family_id": row["repository_family_id"],
                "file": row["file"],
                "code_hash": row["code_hash"],
            })
        clusters.append({
            "cluster_id": f"SEMANTIC_ROOT_{cluster_id:03d}",
            "support": len(members),
            "repository_family_support": len({member["repository_family_id"] for member in members}),
            "language_counts": dict(Counter(member["language"] for member in members)),
            "mean_centroid_fit": round(float(np.mean(fits)), 6),
            "minimum_centroid_fit": round(float(np.min(fits)), 6),
            "members": members,
        })
    residuals = []
    for index, label in enumerate(labels):
        if label >= 0:
            continue
        row = rows[index]
        residuals.append({
            "sample_id": row["sample_id"],
            "purpose": row["semantic_description"]["purpose"],
            "language": row["language"],
            "repository_family_id": row["repository_family_id"],
            "file": row["file"],
            "code_hash": row["code_hash"],
        })
    output = {
        "schema_version": 1,
        "method": "HDBSCAN over normalized embeddings of code-grounded semantic_text only",
        "unit_level": "function",
        "membership_inputs": ["semantic_text"],
        "excluded_membership_inputs": ["code", "language", "file path", "commit text", "AST", "edit structure", "prior labels"],
        "functions_total": len(all_rows),
        "functions_embedded": len(rows),
        "description_abstentions": len(all_rows) - len(rows),
        "new_embeddings_requested": requested,
        "selected_configuration": selected,
        "configuration_diagnostics": diagnostics,
        "clusters": clusters,
        "residuals": residuals,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "functions": len(rows),
        "clusters": len(clusters),
        "clustered": sum(cluster["support"] for cluster in clusters),
        "residuals": len(residuals),
        "selected_configuration": selected,
        "new_embeddings_requested": requested,
    }, indent=2))


if __name__ == "__main__":
    main()

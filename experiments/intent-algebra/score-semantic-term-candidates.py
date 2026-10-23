#!/usr/bin/env python3
"""Score semantic term meanings against every supporting member and competing term."""

from __future__ import annotations

import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--functions", type=Path, required=True)
    parser.add_argument("--candidates", type=Path, required=True)
    parser.add_argument("--embedding-cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--embedding-model", default="text-embedding-3-small")
    parser.add_argument("--dimensions", type=int, default=512)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--bootstrap-samples", type=int, default=500)
    parser.add_argument("--offline", action="store_true")
    return parser.parse_args()


def load_module(path: Path):
    spec = importlib.util.spec_from_file_location("semantic_function_cluster_helpers", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load embedding helpers from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def normalized_mean(matrix: np.ndarray) -> np.ndarray:
    centroid = np.mean(matrix, axis=0)
    norm = np.linalg.norm(centroid)
    if norm == 0:
        raise RuntimeError("Cannot normalize a zero centroid")
    return centroid / norm


def confidence_level(metrics: dict, support: int) -> str:
    if (
        support >= 5
        and metrics["mean_label_fit"] >= 0.60
        and metrics["own_label_vote_share"] >= 0.70
        and metrics["mean_nearest_label_margin"] >= 0.02
    ):
        return "high"
    if (
        support >= 4
        and metrics["mean_label_fit"] >= 0.55
        and metrics["own_label_vote_share"] >= 0.50
        and metrics["mean_nearest_label_margin"] >= 0.0
    ):
        return "medium"
    return "low"


def main() -> None:
    args = parse_args()
    here = Path(__file__).resolve().parent
    helpers = load_module(here / "cluster-semantic-functions.py")
    helpers.load_project_env(here.parents[1] / ".env")
    functions = {row["sample_id"]: row for row in read_jsonl(args.functions)}
    source = json.loads(args.candidates.read_text(encoding="utf-8"))
    candidates = source["candidates"]
    semantic_ids = sorted({member["sample_id"] for candidate in candidates for member in candidate["members"]})
    semantic_texts = [functions[sample_id]["semantic_text"] for sample_id in semantic_ids]
    label_texts = [
        f"Software responsibility: {candidate['name']}\nDefinition: {candidate['definition']}"
        for candidate in candidates
    ]
    combined, requested = helpers.embed_texts(semantic_texts + label_texts, args)
    member_vectors = {sample_id: combined[index] for index, sample_id in enumerate(semantic_ids)}
    label_matrix = combined[len(semantic_ids):]
    rng = np.random.default_rng(20261001)
    scored = []
    for candidate_index, candidate in enumerate(candidates):
        ids = [member["sample_id"] for member in candidate["members"]]
        matrix = np.vstack([member_vectors[sample_id] for sample_id in ids])
        centroid = normalized_mean(matrix)
        centroid_fits = matrix @ centroid
        label_vector = label_matrix[candidate_index]
        label_fits = matrix @ label_vector
        all_label_fits = matrix @ label_matrix.T
        own_votes = np.argmax(all_label_fits, axis=1) == candidate_index
        competitor = np.max(
            np.delete(all_label_fits, candidate_index, axis=1),
            axis=1,
        ) if len(candidates) > 1 else np.zeros(len(ids))
        margins = label_fits - competitor
        bootstrap_alignments = []
        for _ in range(args.bootstrap_samples):
            indexes = rng.integers(0, len(ids), size=len(ids))
            bootstrap_alignments.append(float(normalized_mean(matrix[indexes]) @ centroid))
        metrics = {
            "mean_centroid_fit": round(float(np.mean(centroid_fits)), 6),
            "minimum_centroid_fit": round(float(np.min(centroid_fits)), 6),
            "label_centroid_alignment": round(float(label_vector @ centroid), 6),
            "mean_label_fit": round(float(np.mean(label_fits)), 6),
            "minimum_label_fit": round(float(np.min(label_fits)), 6),
            "own_label_vote_share": round(float(np.mean(own_votes)), 6),
            "mean_nearest_label_margin": round(float(np.mean(margins)), 6),
            "minimum_nearest_label_margin": round(float(np.min(margins)), 6),
            "bootstrap_centroid_alignment_mean": round(float(np.mean(bootstrap_alignments)), 6),
            "bootstrap_centroid_alignment_p10": round(float(np.quantile(bootstrap_alignments, 0.10)), 6),
        }
        scored.append({
            **candidate,
            "semantic_confidence": {
                "level": confidence_level(metrics, candidate["support"]),
                "status": "heuristic pilot confidence; not a calibrated probability",
                **metrics,
            },
        })
    output = {
        "schema_version": 1,
        "method": "cumulative label/member fit, competing-label votes, and bootstrap centroid stability",
        "thresholds": {
            "high": "support>=5, mean label fit>=0.60, own-label vote>=0.70, mean competing-label margin>=0.02",
            "medium": "support>=4, mean label fit>=0.55, own-label vote>=0.50, nonnegative mean competing-label margin",
            "low": "otherwise",
        },
        "new_embeddings_requested": requested,
        "confidence_counts": dict(Counter(candidate["semantic_confidence"]["level"] for candidate in scored)),
        "candidates": scored,
        "rejected_clusters": source["rejected_clusters"],
        "residuals": source["residuals"],
        "registered_count": 0,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "candidates": len(scored),
        "confidence_counts": output["confidence_counts"],
        "new_embeddings_requested": requested,
        "registered_count": 0,
    }, indent=2))


if __name__ == "__main__":
    main()

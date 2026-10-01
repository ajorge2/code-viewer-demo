#!/usr/bin/env python3
"""Retrieve and audit evidence for accepted recursive static-category children."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--discovery-samples", type=Path, required=True)
    parser.add_argument("--static-coverage", type=Path, required=True)
    parser.add_argument("--refinement", type=Path, required=True)
    parser.add_argument("--embedding-cache", type=Path, required=True)
    parser.add_argument("--audit-cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--pool-per-language", type=int, default=250)
    parser.add_argument("--candidates-per-child", type=int, default=20)
    parser.add_argument("--minimum-total-support", type=int, default=5)
    parser.add_argument("--minimum-chars", type=int, default=300)
    parser.add_argument("--maximum-source-chars", type=int, default=50_000)
    parser.add_argument("--excerpt-chars", type=int, default=3_200)
    parser.add_argument("--batch-size", type=int, default=5)
    parser.add_argument("--model", default="gpt-6-astra")
    parser.add_argument("--embedding-model", default="text-embedding-3-small")
    parser.add_argument("--dimensions", type=int, default=512)
    parser.add_argument("--offline", action="store_true")
    return parser.parse_args()


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import helpers from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def normalized(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    if np.any(norms == 0):
        raise RuntimeError("Embedding cache contains a zero vector")
    return matrix / norms


def main() -> None:
    args = parse_args()
    here = Path(__file__).resolve().parent
    static_helpers = load_module("static_coverage_helpers", here / "evaluate-static-component-coverage.py")
    gap_helpers = load_module("static_gap_helpers", here / "expand-static-component-gaps.py")
    embedding_helpers = load_module("intent_embedding_helpers", here / "cluster-embedding-concepts.py")
    embedding_helpers.load_project_env(here.parents[1] / ".env")

    coverage = json.loads(args.static_coverage.read_text(encoding="utf-8"))
    refinement = json.loads(args.refinement.read_text(encoding="utf-8"))
    children = [
        item for item in refinement["children"]
        if item["status"] == "accepted_for_structural_validation"
    ]
    if not children:
        raise RuntimeError("Refinement contains no accepted child categories")

    pool_args = argparse.Namespace(
        data_root=args.data_root,
        discovery_samples=args.discovery_samples,
        per_language=args.pool_per_language,
        minimum_chars=args.minimum_chars,
        maximum_source_chars=args.maximum_source_chars,
        excerpt_chars=args.excerpt_chars,
    )
    pool = static_helpers.sample_unseen_files(pool_args)
    texts = [
        f"Static {item['language']} source file: {item['file']}\nCode:\n{item['code_excerpt']}"
        for item in pool
    ]
    pool_matrix, pool_requests = embedding_helpers.embed_texts(
        texts, model=args.embedding_model, dimensions=args.dimensions, batch_size=64,
        cache_path=args.embedding_cache, offline=args.offline,
    )
    pool_matrix = normalized(np.asarray(pool_matrix))
    pool_index = {item["sample_id"]: index for index, item in enumerate(pool)}

    child_texts = [
        f"Software component category: {item['name']}\nDefinition: {item['definition']}"
        for item in children
    ]
    child_matrix, child_requests = embedding_helpers.embed_texts(
        child_texts, model=args.embedding_model, dimensions=args.dimensions, batch_size=64,
        cache_path=args.embedding_cache, offline=args.offline,
    )
    child_matrix = normalized(np.asarray(child_matrix))

    parent_member_ids = {
        member["sample_id"] for child in refinement["children"] for member in child["members"]
    } | {member["sample_id"] for member in refinement.get("residual_members", [])}
    initial_holdout_ids = {item["sample_id"] for item in coverage["files"]}
    excluded_ids = parent_member_ids | initial_holdout_ids
    retrievals = []
    retrieval_metadata = {}
    gap_descriptors = {}
    for child_index, child in enumerate(children):
        scores = pool_matrix @ child_matrix[child_index]
        seed_scores = [float(scores[pool_index[sample_id]]) for sample_id in child["sample_ids"]]
        floor = min(seed_scores) - 0.05
        chosen = []
        for index in np.argsort(-scores):
            item = pool[int(index)]
            if item["sample_id"] in excluded_ids:
                continue
            chosen.append({
                **item,
                "gap_name": child["name"],
                "retrieval_similarity": round(float(scores[index]), 6),
                "clears_seed_calibrated_floor": bool(float(scores[index]) >= floor),
            })
            if len(chosen) >= args.candidates_per_child:
                break
        retrievals.extend(chosen)
        retrieval_metadata[child["child_id"]] = {
            "seed_similarities": [round(value, 6) for value in seed_scores],
            "retrieval_floor": round(floor, 6),
            "candidate_count": len(chosen),
        }
        gap_descriptors[child["name"]] = {
            "name": child["name"],
            "definition": child["definition"],
            "member_names": [member["name"] for member in child["members"]],
        }

    judgments, judgment_requests = gap_helpers.audit_candidates(
        retrievals, gap_descriptors, args
    )
    results = []
    for child in children:
        candidates = []
        accepted = []
        for item in retrievals:
            if item["gap_name"] != child["name"]:
                continue
            judgment = judgments[(child["name"], item["sample_id"])]
            compact = {
                "sample_id": item["sample_id"],
                "language": item["language"],
                "repository": item["repository"],
                "file": item["file"],
                "row_index": item["row_index"],
                "commit": item["commit"],
                "retrieval_similarity": item["retrieval_similarity"],
                "clears_seed_calibrated_floor": item["clears_seed_calibrated_floor"],
                "judgment": judgment,
            }
            candidates.append(compact)
            if judgment["verdict"] == "entails" and judgment["confidence"] in {"strong", "plausible"}:
                accepted.append(compact)
        total_support = child["support"] + len(accepted)
        results.append({
            "child_id": child["child_id"],
            "name": child["name"],
            "definition": child["definition"],
            "initial_support": child["support"],
            **retrieval_metadata[child["child_id"]],
            "accepted_expansions": len(accepted),
            "total_support": total_support,
            "repository_support": total_support,
            "status": "expanded_child_candidate" if total_support >= args.minimum_total_support else "insufficient_support",
            "initial_sample_ids": child["sample_ids"],
            "accepted_sample_ids": [item["sample_id"] for item in accepted],
            "candidates": candidates,
        })
    payload = {
        "method": "accepted recursive-child definition retrieval followed by code-only entailment audit",
        "role": "evidence expansion before child-level structural validation",
        "pool": {
            "files": len(pool),
            "repositories": len({item["repository"] for item in pool}),
        },
        "parameters": {
            "candidates_per_child": args.candidates_per_child,
            "retrieval_policy": "top-k fallback; seed-calibrated floor retained as an audit field rather than a hard filter",
            "minimum_total_support": args.minimum_total_support,
        },
        "summary": {
            "children_searched": len(children),
            "retrieved_candidates": len(retrievals),
            "accepted_expansions": sum(item["accepted_expansions"] for item in results),
            "expanded_children": sum(item["status"] == "expanded_child_candidate" for item in results),
        },
        "new_embedding_requests": pool_requests + child_requests,
        "new_judgment_requests": judgment_requests,
        "children": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(
        f"Audited {len(retrievals)} recursive-child candidates: "
        f"{payload['summary']['accepted_expansions']} accepted expansions"
    )
    for child in results:
        print(
            f"{child['name']}: {child['initial_support']} + {child['accepted_expansions']} "
            f"= {child['total_support']} ({child['status']})"
        )


if __name__ == "__main__":
    main()

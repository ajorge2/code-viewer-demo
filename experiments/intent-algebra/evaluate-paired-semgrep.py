#!/usr/bin/env python3
"""Join before/after Semgrep prefilters with learned GumTree edit verification."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path


TARGETS = {
    "Python package setup configuration": {
        "node_id": "EMBED_CONCEPT_0002",
        "before_rule": "intent-python-setup-before",
        "after_rule": "intent-python-package-after",
    },
    "Trove taxonomy metadata": {
        "node_id": "EMBED_CONCEPT_0002.S03",
        "before_rule": "intent-python-setup-before",
        "after_rule": "intent-python-trove-after",
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before-results", type=Path, required=True)
    parser.add_argument("--after-results", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--refinement", type=Path, required=True)
    parser.add_argument("--rules", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def load_induction_helpers(path: Path):
    spec = importlib.util.spec_from_file_location("intent_structural_rules", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import structural helpers from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def semgrep_matches(path: Path, path_to_sample: dict[str, str]) -> dict[str, set[str]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    matches: dict[str, set[str]] = {}
    for result in payload.get("results", []):
        sample_id = path_to_sample.get(str(Path(result["path"]).resolve()))
        if sample_id:
            rule_id = result["check_id"].rsplit(".", 1)[-1]
            matches.setdefault(rule_id, set()).add(sample_id)
    return matches


def score(predicted: set[str], positives: set[str], universe: set[str]) -> dict:
    tp = len(predicted & positives)
    fp = len(predicted - positives)
    fn = len(positives - predicted)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    return {
        "true_positive": tp,
        "false_positive": fp,
        "false_negative": fn,
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "f1": round(2 * precision * recall / (precision + recall), 6) if precision + recall else 0.0,
    }


def main() -> None:
    args = parse_args()
    helpers = load_induction_helpers(Path(__file__).with_name("induce-category-structural-rules.py"))
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))["samples"]
    path_to_sample = {
        str(Path(item[key]).resolve()): item["sample_id"]
        for item in manifest
        for key in ("before_path", "after_path")
    }
    before = semgrep_matches(args.before_results, path_to_sample)
    after = semgrep_matches(args.after_results, path_to_sample)
    samples = {
        sample["sample_id"]: sample
        for sample in helpers.read_jsonl(args.samples)
        if sample.get("eligible") and sample["language"] == "python"
    }
    universe = set(samples)
    refinement = json.loads(args.refinement.read_text(encoding="utf-8"))
    refinement_by_id = {node["node_id"]: node for node in refinement["nodes"]}
    rules = json.loads(args.rules.read_text(encoding="utf-8"))
    rule_by_meaning = {category["meaning"]: category for category in rules["categories"]}
    atoms_by_id = {
        sample_id: helpers.structural_atoms(
            sample,
            allow_code_anchors=True,
            allow_context_frames=True,
        )
        for sample_id, sample in samples.items()
    }
    results = []
    for meaning, target in TARGETS.items():
        positives = set(refinement_by_id[target["node_id"]]["hard_member_ids"])
        category = rule_by_meaning[meaning]
        clauses = [tuple(clause["atoms"]) for clause in category["rule"]["clauses"]]
        structurally_verified = {
            sample_id for sample_id, atoms in atoms_by_id.items()
            if any(set(clause).issubset(atoms) for clause in clauses)
        }
        before_ids = before.get(target["before_rule"], set())
        after_ids = after.get(target["after_rule"], set())
        joined = before_ids & after_ids
        paired_verified = joined & structurally_verified
        results.append({
            "node_id": target["node_id"],
            "meaning": meaning,
            "before_rule": target["before_rule"],
            "after_rule": target["after_rule"],
            "before_prefilter_count": len(before_ids),
            "after_prefilter_count": len(after_ids),
            "paired_prefilter_count": len(joined),
            "structurally_verified_count": len(structurally_verified),
            "paired_verified_count": len(paired_verified),
            "prefilter_metrics": score(joined, positives, universe),
            "paired_verified_metrics": score(paired_verified, positives, universe),
            "paired_verified_sample_ids": sorted(paired_verified),
        })
    payload = {
        "method": "before/after Semgrep prefilter join plus GumTree structural-clause verification",
        "python_universe_count": len(universe),
        "results": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    for result in results:
        metrics = result["paired_verified_metrics"]
        print(
            f"{result['meaning']}: precision={metrics['precision']:.3f}, "
            f"recall={metrics['recall']:.3f}, matches={result['paired_verified_count']}"
        )


if __name__ == "__main__":
    main()

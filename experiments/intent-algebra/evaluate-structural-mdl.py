#!/usr/bin/env python3
"""Estimate structural constituent MDL for learned multi-atom clauses.

The category classifier's label-compression score is useful for prediction triage but
is not the proposal's composite-pattern MDL. This evaluator compares the cost of
encoding each recurring multi-atom clause as its constituent atom occurrences with the
cost of a composite clause code plus one-time model storage. Single-atom clauses are
marked not applicable because they contain no structural composition to compress.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rules", type=Path, required=True)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--minimum-ratio", type=float, default=1.2)
    return parser.parse_args()


def load_helpers(path: Path):
    spec = importlib.util.spec_from_file_location("intent_structural_rules", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import structural helpers from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def event_bits(count: int, universe_count: int) -> float:
    probability = (count + 0.5) / (universe_count + 1.0)
    return -math.log2(probability)


def main() -> None:
    args = parse_args()
    helpers = load_helpers(Path(__file__).with_name("induce-category-structural-rules.py"))
    rules = json.loads(args.rules.read_text(encoding="utf-8"))
    samples = {
        sample["sample_id"]: sample
        for sample in helpers.read_jsonl(args.samples)
        if sample.get("eligible")
    }
    atoms_by_id = {
        sample_id: helpers.structural_atoms(
            sample,
            allow_code_anchors=True,
            allow_context_frames=True,
        )
        for sample_id, sample in samples.items()
    }
    postings: dict[str, set[str]] = {}
    for sample_id, atoms in atoms_by_id.items():
        for atom in atoms:
            postings.setdefault(atom, set()).add(sample_id)
    vocabulary_bits = math.log2(max(2, len(postings)))

    results = []
    passing_clause_count = 0
    evaluated_clause_count = 0
    for category in rules["categories"]:
        language = category["language_scope"]
        universe = {
            sample_id
            for sample_id, sample in samples.items()
            if language == "cross_language" or sample["language"] == language
        }
        clauses = []
        for clause in category["rule"]["clauses"]:
            atoms = clause["atoms"]
            if len(atoms) < 2:
                clauses.append({
                    "clause_id": clause["clause_id"],
                    "atom_count": len(atoms),
                    "atoms": atoms,
                    "status": "not_applicable_atomic_clause",
                })
                continue
            evaluated_clause_count += 1
            matched = set(universe)
            for atom in atoms:
                matched &= postings.get(atom, set())
            support = len(matched)
            constituent_bits_per_occurrence = sum(
                event_bits(len(postings.get(atom, set()) & universe), len(universe))
                for atom in atoms
            )
            composite_bits_per_occurrence = event_bits(support, len(universe))
            baseline_bits = support * constituent_bits_per_occurrence
            model_bits = (len(atoms) + 1) * vocabulary_bits + math.log2(len(atoms) + 1)
            encoded_bits = support * composite_bits_per_occurrence + model_bits
            ratio = baseline_bits / encoded_bits if encoded_bits > 0 else 0.0
            passes = support > 0 and ratio >= args.minimum_ratio
            passing_clause_count += int(passes)
            clauses.append({
                "clause_id": clause["clause_id"],
                "atom_count": len(atoms),
                "atoms": atoms,
                "universe_count": len(universe),
                "observed_clause_support": support,
                "constituent_bits_per_occurrence": round(constituent_bits_per_occurrence, 6),
                "composite_bits_per_occurrence": round(composite_bits_per_occurrence, 6),
                "baseline_constituent_bits": round(baseline_bits, 3),
                "composite_model_bits": round(model_bits, 3),
                "encoded_composite_bits": round(encoded_bits, 3),
                "compression_ratio": round(ratio, 6),
                "net_bits_saved": round(baseline_bits - encoded_bits, 3),
                "passes_1_2x": passes,
                "status": "passes_proxy" if passes else "fails_proxy",
            })
        applicable = [clause for clause in clauses if clause["status"] != "not_applicable_atomic_clause"]
        passing = [clause for clause in applicable if clause["status"] == "passes_proxy"]
        results.append({
            "node_id": category["node_id"],
            "meaning": category["meaning"],
            "category_support": category["support"],
            "applicable_composite_clause_count": len(applicable),
            "passing_composite_clause_count": len(passing),
            "best_compression_ratio": max((clause["compression_ratio"] for clause in applicable), default=None),
            "status": (
                "has_passing_composite_proxy" if passing else
                "fails_composite_proxy" if applicable else
                "not_applicable_atomic_rule"
            ),
            "clauses": clauses,
        })
    payload = {
        "method": "prequential-style structural atom occurrence code with one-time composite model storage",
        "scope": "intermediate structural-atom MDL proxy; full GumTree edit-tree code remains required for final promotion",
        "single_atom_policy": "not applicable because an atomic clause has no constituent composition to compress",
        "minimum_compression_ratio": args.minimum_ratio,
        "structural_atom_vocabulary_size": len(postings),
        "evaluated_composite_clause_count": evaluated_clause_count,
        "passing_composite_clause_count": passing_clause_count,
        "categories": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    passing_categories = [result for result in results if result["status"] == "has_passing_composite_proxy"]
    atomic_categories = [result for result in results if result["status"] == "not_applicable_atomic_rule"]
    print(
        f"Evaluated {evaluated_clause_count} multi-atom clauses; {passing_clause_count} pass "
        f"{args.minimum_ratio:.1f}x across {len(passing_categories)} categories; "
        f"{len(atomic_categories)} categories are atomic-only"
    )
    for result in sorted(passing_categories, key=lambda item: -(item["best_compression_ratio"] or 0))[:10]:
        print(f"{result['meaning']}: best ratio={result['best_compression_ratio']:.3f}x")


if __name__ == "__main__":
    main()

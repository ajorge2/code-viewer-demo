#!/usr/bin/env python3
"""Run role-aware metamorphic probes over learned structural clauses.

Positive probes randomize local identifiers and string literals while preserving the
stable API/keyword anchors named by a rule. Negative probes preserve AST shape but
randomize the anchor itself. This separates valid name invariance from the destructive
idea of randomizing the semantic API symbol that gives a rule its meaning.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import re


ANCHOR_TYPES = {
    "identifier",
    "property_identifier",
    "shorthand_property_identifier",
    "string",
    "string_fragment",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rules", type=Path, required=True)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def load_helpers(path: Path):
    spec = importlib.util.spec_from_file_location("intent_structural_rules", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import structural helpers from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def normalized_label(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().strip("'\"").lower()
    return normalized or None


def clause_anchor_values(atoms: list[str]) -> set[str]:
    values = set()
    for atom in atoms:
        match = re.search(r"(?:^|_)anchor:[^=]+=([^:]+)(?::|$)", atom)
        if match:
            values.add(match.group(1).lower())
        context_match = re.match(r"context_anchor:(.+)", atom)
        if context_match:
            values.add(context_match.group(1).lower())
    return values


def synthetic_label(sample_id: str, index: int, item_type: str, original: str) -> str:
    token = "synthetic_" + sha256(f"{sample_id}:{index}:{original}".encode("utf-8")).hexdigest()[:10]
    return f"'{token}'" if item_type in {"string", "string_fragment"} else token


def iter_labeled_items(sample: dict):
    for action in (sample.get("analysis") or {}).get("actions") or []:
        for item in action.get("subtree") or []:
            yield item
        for frame in action.get("context_frames") or []:
            for item in frame.get("subtree") or []:
                yield item


def randomize_labels(sample: dict, preserved: set[str], *, mutate_preserved: bool) -> dict:
    output = deepcopy(sample)
    for index, item in enumerate(iter_labeled_items(output)):
        item_type = str(item.get("type") or "")
        original = item.get("label")
        normalized = normalized_label(original)
        if item_type not in ANCHOR_TYPES or normalized is None:
            continue
        is_preserved = normalized in preserved
        if is_preserved == mutate_preserved:
            item["label"] = synthetic_label(output["sample_id"], index, item_type, str(original))
    if mutate_preserved:
        for field in ("before_excerpt", "after_excerpt"):
            value = output.get(field)
            if not isinstance(value, str):
                continue
            for anchor in preserved:
                value = re.sub(rf"\b{re.escape(anchor)}\b", f"synthetic_{anchor}", value, flags=re.IGNORECASE)
            output[field] = value
    return output


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
    categories = []
    total_positive = total_positive_pass = 0
    total_negative = total_negative_pass = 0
    for category in rules["categories"]:
        language = category["language_scope"]
        universe = {
            sample_id
            for sample_id, sample in samples.items()
            if language == "cross_language" or sample["language"] == language
        }
        clause_results = []
        for clause in category["rule"]["clauses"]:
            atoms = set(clause["atoms"])
            anchors = clause_anchor_values(clause["atoms"])
            matching_ids = [sample_id for sample_id in universe if atoms.issubset(atoms_by_id[sample_id])]
            positive_pass = 0
            negative_pass = 0
            negative_count = 0
            for sample_id in matching_ids:
                positive = randomize_labels(samples[sample_id], anchors, mutate_preserved=False)
                positive_atoms = helpers.structural_atoms(
                    positive,
                    allow_code_anchors=True,
                    allow_context_frames=True,
                )
                positive_pass += int(atoms.issubset(positive_atoms))
                if anchors:
                    negative_count += 1
                    negative = randomize_labels(samples[sample_id], anchors, mutate_preserved=True)
                    negative_atoms = helpers.structural_atoms(
                        negative,
                        allow_code_anchors=True,
                        allow_context_frames=True,
                    )
                    negative_pass += int(not atoms.issubset(negative_atoms))
            total_positive += len(matching_ids)
            total_positive_pass += positive_pass
            total_negative += negative_count
            total_negative_pass += negative_pass
            clause_results.append({
                "clause_id": clause["clause_id"],
                "atoms": clause["atoms"],
                "preserved_anchor_values": sorted(anchors),
                "matched_sample_count": len(matching_ids),
                "local_name_invariance_rate": round(positive_pass / len(matching_ids), 6) if matching_ids else None,
                "anchor_mutation_rejection_rate": round(negative_pass / negative_count, 6) if negative_count else None,
                "positive_failures": len(matching_ids) - positive_pass,
                "negative_failures": negative_count - negative_pass,
            })
        positive_rates = [item["local_name_invariance_rate"] for item in clause_results if item["local_name_invariance_rate"] is not None]
        negative_rates = [item["anchor_mutation_rejection_rate"] for item in clause_results if item["anchor_mutation_rejection_rate"] is not None]
        categories.append({
            "node_id": category["node_id"],
            "meaning": category["meaning"],
            "rule_status": category["status"],
            "minimum_local_name_invariance_rate": min(positive_rates) if positive_rates else None,
            "minimum_anchor_mutation_rejection_rate": min(negative_rates) if negative_rates else None,
            "passes_role_aware_probe": (
                bool(positive_rates)
                and min(positive_rates) == 1.0
                and (not negative_rates or min(negative_rates) >= 0.95)
            ),
            "clauses": clause_results,
        })
    payload = {
        "method": "randomize local AST labels while preserving rule anchors; then mutate anchors while preserving AST shape",
        "scope": "persisted GumTree subtrees and typed context frames; source reparse probe remains future work",
        "aggregate": {
            "positive_probe_count": total_positive,
            "positive_probe_pass_count": total_positive_pass,
            "local_name_invariance_rate": round(total_positive_pass / total_positive, 6) if total_positive else None,
            "negative_anchor_probe_count": total_negative,
            "negative_anchor_probe_pass_count": total_negative_pass,
            "anchor_mutation_rejection_rate": round(total_negative_pass / total_negative, 6) if total_negative else None,
        },
        "categories": categories,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    aggregate = payload["aggregate"]
    print(
        f"Local-name invariance: {aggregate['positive_probe_pass_count']}/"
        f"{aggregate['positive_probe_count']} ({aggregate['local_name_invariance_rate']:.3f}); "
        f"anchor rejection: {aggregate['negative_anchor_probe_pass_count']}/"
        f"{aggregate['negative_anchor_probe_count']} ({aggregate['anchor_mutation_rejection_rate']:.3f})"
    )
    for category in categories:
        if category["meaning"] in {"Python package setup configuration", "Trove taxonomy metadata"}:
            print(
                f"{category['meaning']}: invariance={category['minimum_local_name_invariance_rate']}, "
                f"anchor rejection={category['minimum_anchor_mutation_rejection_rate']}, "
                f"passes={category['passes_role_aware_probe']}"
            )


if __name__ == "__main__":
    main()

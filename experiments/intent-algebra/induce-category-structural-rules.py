#!/usr/bin/env python3
"""Induce category-conditioned structural AND/OR rules with held-out evaluation.

Semantic nodes are the targets.  Candidate rule atoms come only from GumTree/AST
structure; commit text, paths, identifiers, and embedding coordinates are excluded.
Each category receives an OR of short AND clauses, selected on training folds and
evaluated on deterministic held-out folds before a final rule is fit on all data.
"""

from __future__ import annotations

import argparse
from collections import Counter
from hashlib import sha256
from itertools import combinations
import json
import math
from pathlib import Path
import re
from typing import Iterable


GENERIC_NODE_TYPES = {
    "identifier",
    "comment",
    "module",
    "program",
    "block",
    "expression_statement",
}

GENERIC_CONTEXT_TOKENS = {
    "and", "arguments", "array", "async", "await", "break", "call", "case",
    "catch", "class", "const", "continue", "def", "default", "delete", "do",
    "else", "except", "export", "extends", "false", "finally", "for", "from",
    "function", "if", "import", "in", "instanceof", "let", "new", "none", "null",
    "object", "of", "or", "pass", "raise", "return", "self", "static", "super",
    "switch", "this", "throw", "true", "try", "typeof", "undefined", "var", "while",
    "with", "yield",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--meanings", type=Path, required=True)
    parser.add_argument("--refinement", type=Path, required=True)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--confidence-levels", default="high,medium")
    parser.add_argument("--folds", type=int, default=3)
    parser.add_argument("--maximum-atoms-per-clause", type=int, default=3)
    parser.add_argument("--maximum-clauses", type=int, default=6)
    parser.add_argument("--maximum-ranked-atoms", type=int, default=48)
    parser.add_argument("--minimum-training-precision", type=float, default=0.35)
    parser.add_argument("--minimum-lift", type=float, default=3.0)
    parser.add_argument(
        "--allow-code-anchors",
        action="store_true",
        help="Allow recurrent identifier/property/string symbols from AST nodes as explicit rule anchors",
    )
    parser.add_argument(
        "--allow-context-anchors",
        action="store_true",
        help="Allow recurrent code tokens from bounded before/after evidence windows",
    )
    parser.add_argument(
        "--allow-context-frames",
        action="store_true",
        help="Use bounded typed AST neighborhoods emitted around each edit",
    )
    parser.add_argument(
        "--require-structural-atom",
        action="store_true",
        help="Reject clauses made only of lexical anchors",
    )
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def stable_hash(value: str) -> int:
    return int(sha256(value.encode("utf-8")).hexdigest()[:16], 16)


def clean_type(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    cleaned = value.replace(" ", "_")
    return cleaned if re.search(r"[A-Za-z_]", cleaned) else None


def code_anchor(item: dict) -> str | None:
    item_type = clean_type(item.get("type"))
    label = item.get("label")
    if item_type not in {
        "identifier",
        "property_identifier",
        "shorthand_property_identifier",
        "string",
        "string_fragment",
    } or not isinstance(label, str):
        return None
    value = label.strip().strip("'\"").lower()
    if not re.fullmatch(r"[a-z_$][a-z0-9_$.-]{1,47}", value):
        return None
    if value in {"self", "this", "true", "false", "none", "null", "undefined"}:
        return None
    return f"anchor:{item_type}={value}"


def structural_atoms(
    sample: dict,
    *,
    allow_code_anchors: bool = False,
    allow_context_anchors: bool = False,
    allow_context_frames: bool = False,
) -> set[str]:
    """Create name-invariant atoms from the persisted AST edit script."""
    atoms: set[str] = set()
    analysis = sample.get("analysis") or {}
    actions = analysis.get("actions") or []
    for action in actions:
        kind = clean_type(action.get("action"))
        node = action.get("node") or {}
        root_type = clean_type(node.get("type"))
        if not kind or not root_type:
            continue
        atoms.add(f"action:{kind}")
        atoms.add(f"root:{root_type}")
        atoms.add(f"edit:{kind}>{root_type}")
        parent_type = clean_type((action.get("parent") or {}).get("type"))
        if parent_type:
            atoms.add(f"context:{kind}>{root_type}@{parent_type}")
        for ancestor in node.get("ancestors") or []:
            ancestor_type = clean_type(ancestor.get("type"))
            if ancestor_type and ancestor_type != root_type:
                atoms.add(f"ancestor:{root_type}@{ancestor_type}")

        subtree = action.get("subtree") or []
        by_id = {item.get("id"): item for item in subtree}
        for item in subtree:
            item_type = clean_type(item.get("type"))
            if not item_type:
                continue
            if allow_code_anchors:
                anchor = code_anchor(item)
                if anchor:
                    atoms.add(anchor)
            if item_type not in GENERIC_NODE_TYPES:
                atoms.add(f"node:{kind}>{item_type}")
            parent = by_id.get(item.get("parent"))
            parent_node_type = clean_type(parent.get("type")) if parent else None
            if (
                parent_node_type
                and item_type not in GENERIC_NODE_TYPES
                and parent_node_type not in GENERIC_NODE_TYPES
            ):
                atoms.add(f"edge:{kind}>{parent_node_type}>{item_type}")

        if allow_context_frames:
            for frame in action.get("context_frames") or []:
                frame_type = clean_type(frame.get("type"))
                if not frame_type:
                    continue
                atoms.add(f"frame:{kind}>{frame_type}")
                frame_subtree = frame.get("subtree") or []
                frame_by_id = {item.get("id"): item for item in frame_subtree}
                for item in frame_subtree:
                    item_type = clean_type(item.get("type"))
                    if not item_type:
                        continue
                    if item_type not in GENERIC_NODE_TYPES:
                        atoms.add(f"frame_node:{kind}>{frame_type}>{item_type}")
                    anchor = code_anchor(item)
                    if anchor:
                        atoms.add(f"frame_{anchor}:{kind}>{frame_type}")
                    parent = frame_by_id.get(item.get("parent"))
                    parent_type = clean_type(parent.get("type")) if parent else None
                    if (
                        parent_type
                        and item_type not in GENERIC_NODE_TYPES
                        and parent_type not in GENERIC_NODE_TYPES
                    ):
                        atoms.add(f"frame_edge:{kind}>{frame_type}>{parent_type}>{item_type}")

    for component in sample.get("components") or []:
        component_type = clean_type(component.get("type"))
        if component_type and component_type not in GENERIC_NODE_TYPES:
            atoms.add(f"component:{component_type}")
    if allow_context_anchors:
        evidence = "\n".join([
            sample.get("before_excerpt") or "",
            sample.get("after_excerpt") or "",
        ])
        for token in set(re.findall(r"[A-Za-z_$][A-Za-z0-9_$]{2,47}", evidence)):
            normalized = token.lower()
            if normalized not in GENERIC_CONTEXT_TOKENS:
                atoms.add(f"context_anchor:{normalized}")
    atoms.add(f"component_count:{min(int(sample.get('component_count') or 0), 3)}")
    return atoms


def metrics(predicted: set[str], positives: set[str], universe: set[str]) -> dict:
    tp = len(predicted & positives)
    fp = len(predicted - positives)
    fn = len(positives - predicted)
    tn = len(universe - positives - predicted)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "true_positive": tp,
        "false_positive": fp,
        "false_negative": fn,
        "true_negative": tn,
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "f1": round(f1, 6),
    }


def clause_matches(clause: tuple[str, ...], postings: dict[str, set[str]]) -> set[str]:
    matches: set[str] | None = None
    for atom in clause:
        atom_matches = postings.get(atom, set())
        matches = set(atom_matches) if matches is None else matches & atom_matches
        if not matches:
            return set()
    return matches or set()


def rule_matches(clauses: Iterable[tuple[str, ...]], postings: dict[str, set[str]]) -> set[str]:
    output: set[str] = set()
    for clause in clauses:
        output.update(clause_matches(clause, postings))
    return output


def f_beta(precision: float, recall: float, beta: float = 0.75) -> float:
    if precision <= 0 or recall <= 0:
        return 0.0
    beta_sq = beta * beta
    return (1 + beta_sq) * precision * recall / (beta_sq * precision + recall)


def enumerative_bits(total: int, marked: int) -> float:
    if total <= 0 or marked < 0 or marked > total:
        return 0.0
    combinations_bits = (
        math.lgamma(total + 1) - math.lgamma(marked + 1) - math.lgamma(total - marked + 1)
    ) / math.log(2)
    return math.log2(total + 1) + combinations_bits


def rule_storage_bits(clauses: list[tuple[str, ...]], vocabulary_size: int) -> float:
    atom_bits = math.log2(max(vocabulary_size, 2))
    return sum(
        math.log2(7) + len(clause) * (atom_bits + 1.0)
        for clause in clauses
    )


def candidate_clauses(
    positives: set[str],
    universe: set[str],
    atoms_by_id: dict[str, set[str]],
    postings: dict[str, set[str]],
    args: argparse.Namespace,
) -> list[dict]:
    positive_count = Counter(
        atom for sample_id in positives for atom in atoms_by_id[sample_id]
    )
    minimum_support = max(2, math.ceil(len(positives) * 0.12))
    prevalence = len(positives) / max(len(universe), 1)
    ranked = []
    for atom, count in positive_count.items():
        if count < minimum_support:
            continue
        matched = postings.get(atom, set()) & universe
        precision = count / max(len(matched), 1)
        lift = precision / max(prevalence, 1e-9)
        score = precision * math.log1p(count) * math.log1p(lift)
        ranked.append((score, atom))
    ranked_atoms = {
        atom for _score, atom in sorted(ranked, reverse=True)[: args.maximum_ranked_atoms]
    }

    clauses: set[tuple[str, ...]] = {(atom,) for atom in ranked_atoms}
    for sample_id in positives:
        present = sorted(atoms_by_id[sample_id] & ranked_atoms)
        for size in range(2, args.maximum_atoms_per_clause + 1):
            clauses.update(combinations(present, size))

    output = []
    for clause in clauses:
        if args.require_structural_atom and all(
            atom.startswith(("anchor:", "context_anchor:")) for atom in clause
        ):
            continue
        matched = clause_matches(clause, postings) & universe
        positive_support = len(matched & positives)
        if positive_support < minimum_support:
            continue
        precision = positive_support / max(len(matched), 1)
        recall = positive_support / len(positives)
        lift = precision / max(prevalence, 1e-9)
        if precision < args.minimum_training_precision or lift < args.minimum_lift:
            continue
        output.append({
            "atoms": clause,
            "matches": matched,
            "positive_support": positive_support,
            "precision": precision,
            "recall": recall,
            "lift": lift,
            "score": f_beta(precision, recall) - 0.0125 * (len(clause) - 1),
        })
    return sorted(
        output,
        key=lambda value: (
            -value["score"],
            -value["precision"],
            -value["positive_support"],
            len(value["atoms"]),
            value["atoms"],
        ),
    )


def induce_rule(
    positives: set[str],
    universe: set[str],
    atoms_by_id: dict[str, set[str]],
    postings: dict[str, set[str]],
    args: argparse.Namespace,
) -> list[tuple[str, ...]]:
    candidates = candidate_clauses(positives, universe, atoms_by_id, postings, args)
    selected: list[tuple[str, ...]] = []
    predicted: set[str] = set()
    current_score = 0.0
    while len(selected) < args.maximum_clauses:
        best = None
        for candidate in candidates:
            clause = candidate["atoms"]
            if clause in selected:
                continue
            combined = predicted | candidate["matches"]
            result = metrics(combined, positives, universe)
            score = f_beta(result["precision"], result["recall"])
            score -= 0.008 * sum(len(value) - 1 for value in [*selected, clause])
            newly_covered = len((combined - predicted) & positives)
            if newly_covered == 0:
                continue
            key = (score, result["precision"], result["recall"], -len(clause))
            if best is None or key > best[0]:
                best = (key, clause, combined, score)
        if best is None or best[3] <= current_score + 1e-9:
            break
        _key, clause, predicted, current_score = best
        selected.append(clause)
    return selected


def language_universe(member_ids: set[str], samples: dict[str, dict]) -> tuple[set[str], str]:
    languages = Counter(samples[sample_id]["language"] for sample_id in member_ids)
    language, count = languages.most_common(1)[0]
    if count / len(member_ids) >= 0.90:
        return {
            sample_id for sample_id, sample in samples.items()
            if sample.get("eligible") and sample["language"] == language
        }, language
    return {
        sample_id for sample_id, sample in samples.items() if sample.get("eligible")
    }, "mixed"


def positive_folds(positive_ids: set[str], fold_count: int) -> dict[str, int]:
    ordered = sorted(positive_ids, key=lambda sample_id: (stable_hash(sample_id), sample_id))
    return {sample_id: index % fold_count for index, sample_id in enumerate(ordered)}


def cross_validate(
    positives: set[str],
    universe: set[str],
    atoms_by_id: dict[str, set[str]],
    postings: dict[str, set[str]],
    args: argparse.Namespace,
) -> tuple[dict, list[list[tuple[str, ...]]]]:
    positive_fold = positive_folds(positives, args.folds)
    fold_rules = []
    fold_model_bits = []
    totals = Counter()
    fold_results = []
    for fold in range(args.folds):
        validation = {
            sample_id for sample_id in universe
            if (positive_fold.get(sample_id, stable_hash(sample_id) % args.folds)) == fold
        }
        train = universe - validation
        train_positives = positives & train
        validation_positives = positives & validation
        clauses = induce_rule(train_positives, train, atoms_by_id, postings, args)
        predicted = rule_matches(clauses, postings) & validation
        result = metrics(predicted, validation_positives, validation)
        fold_rules.append(clauses)
        fold_model_bits.append(rule_storage_bits(clauses, len(postings)))
        totals.update({
            "true_positive": result["true_positive"],
            "false_positive": result["false_positive"],
            "false_negative": result["false_negative"],
            "true_negative": result["true_negative"],
        })
        fold_results.append({
            "fold": fold,
            "positive_count": len(validation_positives),
            "universe_count": len(validation),
            "clause_count": len(clauses),
            **result,
        })
    tp, fp, fn = totals["true_positive"], totals["false_positive"], totals["false_negative"]
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    micro = {
        **dict(totals),
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "f1": round(2 * precision * recall / (precision + recall), 6) if precision + recall else 0.0,
    }
    atom_sets = [{atom for clause in rules for atom in clause} for rules in fold_rules]
    jaccards = []
    for left, right in combinations(atom_sets, 2):
        union = left | right
        jaccards.append(len(left & right) / len(union) if union else 1.0)
    micro["mean_rule_atom_jaccard"] = round(sum(jaccards) / len(jaccards), 6) if jaccards else 1.0
    baseline_bits = enumerative_bits(len(universe), len(positives))
    error_count = totals["false_positive"] + totals["false_negative"]
    residual_bits = enumerative_bits(len(universe), error_count)
    mean_model_bits = sum(fold_model_bits) / len(fold_model_bits) if fold_model_bits else 0.0
    encoded_bits = residual_bits + mean_model_bits
    compression_ratio = baseline_bits / encoded_bits if encoded_bits > 0 else 0.0
    micro["mdl"] = {
        "baseline_bits": round(baseline_bits, 3),
        "residual_error_bits": round(residual_bits, 3),
        "mean_fold_rule_bits": round(mean_model_bits, 3),
        "encoded_bits": round(encoded_bits, 3),
        "compression_ratio": round(compression_ratio, 6),
        "passes_1_2x": compression_ratio >= 1.2,
        "definition": "enumerative label code divided by out-of-fold error code plus mean fold rule storage",
    }
    return {"micro": micro, "folds": fold_results}, fold_rules


def serialize_rule(
    clauses: list[tuple[str, ...]],
    positives: set[str],
    universe: set[str],
    postings: dict[str, set[str]],
) -> dict:
    predicted = rule_matches(clauses, postings) & universe
    serialized = []
    for index, clause in enumerate(clauses, start=1):
        matched = clause_matches(clause, postings) & universe
        serialized.append({
            "clause_id": f"CLAUSE_{index:02d}",
            "operator": "AND",
            "atoms": list(clause),
            "positive_support": len(matched & positives),
            "total_matches": len(matched),
            "precision": round(len(matched & positives) / max(len(matched), 1), 6),
            "supporting_sample_ids": sorted(matched & positives)[:10],
            "false_positive_sample_ids": sorted(matched - positives)[:5],
        })
    return {
        "operator": "OR",
        "clauses": serialized,
        "fit_on_all_data": metrics(predicted, positives, universe),
    }


def main() -> None:
    args = parse_args()
    accepted_levels = {value.strip() for value in args.confidence_levels.split(",") if value.strip()}
    meanings = json.loads(args.meanings.read_text(encoding="utf-8"))
    refinement = json.loads(args.refinement.read_text(encoding="utf-8"))
    samples = {
        sample["sample_id"]: sample for sample in read_jsonl(args.samples)
        if sample.get("eligible")
    }
    atoms_by_id = {
        sample_id: structural_atoms(
            sample,
            allow_code_anchors=args.allow_code_anchors,
            allow_context_anchors=args.allow_context_anchors,
            allow_context_frames=args.allow_context_frames,
        )
        for sample_id, sample in samples.items()
    }
    postings: dict[str, set[str]] = {}
    for sample_id, atoms in atoms_by_id.items():
        for atom in atoms:
            postings.setdefault(atom, set()).add(sample_id)

    refinement_by_id = {node["node_id"]: node for node in refinement["nodes"]}
    targets = [
        node for node in meanings["nodes"]
        if node["confidence"]["level"] in accepted_levels
    ]
    targets.sort(key=lambda node: (-node["support"], node["node_id"]))
    results = []
    for meaning in targets:
        node = refinement_by_id[meaning["node_id"]]
        positives = set(node["hard_member_ids"])
        universe, language_scope = language_universe(positives, samples)
        positives &= universe
        validation, _fold_rules = cross_validate(
            positives, universe, atoms_by_id, postings, args
        )
        clauses = induce_rule(positives, universe, atoms_by_id, postings, args)
        rule = serialize_rule(clauses, positives, universe, postings)
        cv = validation["micro"]
        if (
            cv["precision"] >= 0.80
            and cv["recall"] >= 0.40
            and meaning["support"] >= 10
            and cv["mdl"]["passes_1_2x"]
        ):
            status = "strong_provisional"
        elif cv["precision"] >= 0.60 and cv["recall"] >= 0.25:
            status = "weak_provisional"
        else:
            status = "insufficient_structural_rule"
        results.append({
            "node_id": meaning["node_id"],
            "meaning": meaning["chosen_meaning"]["name"],
            "semantic_confidence": meaning["confidence"]["level"],
            "support": meaning["support"],
            "language_scope": language_scope,
            "comparison_universe_count": len(universe),
            "status": status,
            "cross_validation": validation,
            "rule": rule,
        })

    status_counts = Counter(result["status"] for result in results)
    payload = {
        "method": "category-conditioned AST rule induction with deterministic held-out folds",
        "rule_form": "OR of AND clauses",
        "semantic_precedence": True,
        "leakage_controls": {
            "commit_text_used": False,
            "file_paths_used": False,
            "identifiers_or_literal_values_used": args.allow_code_anchors,
            "embedding_coordinates_used": False,
            "same_language_negative_universe_for_language_specific_categories": True,
        },
        "code_anchor_policy": (
            "stable symbols are retained only inside bounded typed AST context frames; local-name versus API-anchor classification and metamorphic exemptions remain required"
            if args.allow_context_frames else
            "recurrent AST identifier/property/string values and bounded code-context tokens are explicit anchors; local-name versus API-anchor classification and metamorphic exemptions remain required"
            if args.allow_context_anchors else
            "recurrent AST identifier/property/string values are explicit anchors; local-name versus API-anchor classification and metamorphic exemptions remain required"
            if args.allow_code_anchors else
            "all identifier and literal values are excluded"
        ),
        "limitations": [
            "Rules are structural intermediate representations, not yet compiled paired Semgrep matchers.",
            "Cross-validation is patch-level; repository-family splits await provenance enrichment.",
            "Promotion still requires repository independence and held-out MDL gain.",
        ],
        "parameters": {
            "confidence_levels": sorted(accepted_levels),
            "folds": args.folds,
            "maximum_atoms_per_clause": args.maximum_atoms_per_clause,
            "maximum_clauses": args.maximum_clauses,
            "minimum_training_precision": args.minimum_training_precision,
            "minimum_lift": args.minimum_lift,
            "require_structural_atom": args.require_structural_atom,
            "typed_context_frames": args.allow_context_frames,
            "minimum_mdl_compression_ratio_for_strong_status": 1.2,
        },
        "target_count": len(results),
        "status_counts": dict(sorted(status_counts.items())),
        "categories": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(
        f"Induced structural rules for {len(results)} semantic nodes: "
        + ", ".join(f"{key}={value}" for key, value in sorted(status_counts.items()))
    )


if __name__ == "__main__":
    main()

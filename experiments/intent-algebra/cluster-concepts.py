#!/usr/bin/env python3
"""Explore broad, overlapping concept clusters above the orthogonal edit facets."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from sklearn.decomposition import NMF
from sklearn.feature_extraction.text import TfidfVectorizer


GENERIC_TOKENS = {
    "already", "app", "array", "assert", "class", "component", "components",
    "field", "file", "files", "find", "global", "id", "init", "insert", "max",
    "module", "modules", "name", "object", "public", "script", "scripts", "self",
    "setup", "text", "value",
}

NORMALIZE = {
    "dependencies": "dependency",
    "dependents": "dependency",
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
        "--output",
        type=Path,
        default=root / ".data/intent-pilot-additive/concept-clusters.json",
    )
    parser.add_argument(
        "--figure",
        type=Path,
        default=root / "docs/figures/intent-algebra-additive/05-concept-clusters.svg",
    )
    parser.add_argument("--topics", type=int, default=6)
    parser.add_argument("--min-document-frequency", type=int, default=2)
    parser.add_argument("--membership-threshold", type=float, default=0.2)
    return parser.parse_args()


def weighted_tokens(record: dict) -> list[str]:
    sources = record["concept_tokens"]
    tokens = (
        sources["changed_code"] * 3
        + sources["file_path"] * 2
        + sources["commit_subject"]
    )
    normalized = [NORMALIZE.get(token, token) for token in tokens]
    return [token for token in normalized if token not in GENERIC_TOKENS]


def noun_label(terms: list[dict]) -> str:
    return " · ".join(term["term"] for term in terms[:3])


def svg_figure(clusters: list[dict], path: Path, record_count: int) -> None:
    width = 1400
    row_height = 102
    height = 155 + row_height * len(clusters) + 85
    colors = ["#2563eb", "#7c3aed", "#138a72", "#d97706", "#d94f70", "#58748f"]
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        '<style>text{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.title{font-size:31px;font-weight:700;fill:#172033}.sub{font-size:17px;fill:#667085}.label{font-size:18px;font-weight:700;fill:#172033}.term{font-size:15px;fill:#344054}.note{font-size:14px;fill:#667085}</style>',
        '<text x="70" y="60" class="title">Exploratory macro-concept clusters</text>',
        f'<text x="70" y="93" class="sub">Soft NMF topics over lexical context from {record_count} addition-dominant changes; clusters may overlap</text>',
    ]
    for index, cluster in enumerate(clusters):
        color = colors[index % len(colors)]
        y = 145 + index * row_height
        parts.append(f'<text x="70" y="{y + 23}" class="label">{index + 1}. {cluster["label"]}</text>')
        parts.append(f'<text x="70" y="{y + 48}" class="note">{cluster["support"]} changes above membership threshold</text>')
        x = 440
        max_weight = cluster["terms"][0]["weight"] or 1
        for term in cluster["terms"][:6]:
            bar = 105 * term["weight"] / max_weight
            parts.append(f'<rect x="{x}" y="{y + 6}" width="{bar:.1f}" height="18" rx="4" fill="{color}" opacity="0.82"/>')
            parts.append(f'<text x="{x}" y="{y + 48}" class="term">{term["term"]}</text>')
            x += 145
        parts.append(f'<line x1="70" y1="{y + 77}" x2="1330" y2="{y + 77}" stroke="#e3e7ee"/>')
    parts.append(f'<text x="70" y="{height - 35}" class="note">Topic labels are top recurrent nouns, not validated ontology names or exclusive assignments.</text>')
    parts.append("</svg>")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(parts) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    records = [json.loads(line) for line in args.input.read_text().splitlines() if line.strip()]
    documents = [weighted_tokens(record) for record in records]
    vectorizer = TfidfVectorizer(
        analyzer=lambda value: value,
        lowercase=False,
        min_df=args.min_document_frequency,
        sublinear_tf=True,
        norm="l2",
    )
    matrix = vectorizer.fit_transform(documents)
    nonempty = np.asarray(matrix.getnnz(axis=1)).ravel() > 0
    fitted_matrix = matrix[nonempty]
    fitted_records = [record for record, keep in zip(records, nonempty, strict=True) if keep]
    if fitted_matrix.shape[0] < args.topics:
        raise ValueError("Not enough non-empty records for the requested topic count")

    model = NMF(
        n_components=args.topics,
        init="nndsvda",
        random_state=0,
        max_iter=1_000,
        alpha_W=0.0,
        alpha_H=0.0,
        l1_ratio=0.0,
    )
    membership = model.fit_transform(fitted_matrix)
    if np.allclose(model.components_, 0):
        raise RuntimeError("Topic model collapsed to zero components")
    membership /= np.maximum(membership.sum(axis=1, keepdims=True), 1e-12)
    terms = np.asarray(vectorizer.get_feature_names_out())
    clusters = []
    for topic_index, weights in enumerate(model.components_):
        term_indexes = weights.argsort()[::-1][:10]
        top_terms = [
            {"term": str(terms[index]), "weight": round(float(weights[index]), 6)}
            for index in term_indexes
            if weights[index] > 0
        ]
        document_indexes = membership[:, topic_index].argsort()[::-1]
        examples = [
            {
                "sample_id": fitted_records[index]["sample_id"],
                "subject": fitted_records[index]["subject"],
                "primary_entity": fitted_records[index]["primary_entity_name"],
                "membership": round(float(membership[index, topic_index]), 6),
            }
            for index in document_indexes[:8]
        ]
        support = int(np.count_nonzero(membership[:, topic_index] >= args.membership_threshold))
        clusters.append({
            "topic_id": topic_index,
            "label": noun_label(top_terms),
            "support": support,
            "terms": top_terms,
            "examples": examples,
        })
    clusters.sort(key=lambda cluster: (-cluster["support"], cluster["label"]))
    payload = {
        "method": "TF-IDF + non-negative matrix factorization",
        "library_versions": {
            "numpy": np.__version__,
            "scikit_learn": __import__("sklearn").__version__,
        },
        "parameters": {
            "topics": args.topics,
            "min_document_frequency": args.min_document_frequency,
            "membership_threshold": args.membership_threshold,
            "source_weights": {"changed_code": 3, "file_path": 2, "commit_subject": 1},
            "random_state": 0,
        },
        "records": len(records),
        "records_with_recurrent_vocabulary": len(fitted_records),
        "vocabulary_size": int(matrix.shape[1]),
        "reconstruction_error": float(model.reconstruction_err_),
        "interpretation": "Exploratory overlapping macro-concepts; not orthogonal primitives or accepted taxonomy labels.",
        "clusters": clusters,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    svg_figure(clusters, args.figure, len(records))
    print(f"Wrote {len(clusters)} exploratory clusters to {args.output}")


if __name__ == "__main__":
    main()

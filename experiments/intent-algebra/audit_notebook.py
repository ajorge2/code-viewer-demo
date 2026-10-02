"""Read-only helpers for the Steps 1-2 calibration audit notebook.

The executor owns artifact creation. These helpers deliberately avoid model calls and
pipeline mutations so rerunning the notebook cannot change experiment results.
"""

from __future__ import annotations

from collections import Counter
from difflib import SequenceMatcher
from hashlib import sha256
from html import escape
import json
from pathlib import Path
from typing import Any, Iterable


ARTIFACT_FILES = {
    "manifest": "run-manifest.json",
    "index": "artifact-index.json",
    "records": "records.jsonl",
    "claims": "claims.jsonl",
    "candidates": "ast-candidates.jsonl",
    "labels": "code-labels.jsonl",
    "unresolved": "unresolved.jsonl",
    "summary": "calibration-summary.json",
    "review_sample": "review-sample.jsonl",
    "review_decisions": "review-decisions.jsonl",
}


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSONL at {path}:{line_number}: {exc}") from exc
            if not isinstance(value, dict):
                raise ValueError(f"Expected object at {path}:{line_number}")
            rows.append(value)
    return rows


def file_sha256(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def artifact_inventory(run_root: Path) -> list[dict[str, Any]]:
    inventory = []
    for name, filename in ARTIFACT_FILES.items():
        path = run_root / filename
        inventory.append(
            {
                "artifact": name,
                "filename": filename,
                "exists": path.exists(),
                "bytes": path.stat().st_size if path.exists() else 0,
                "sha256": file_sha256(path) if path.exists() else None,
            }
        )
    return inventory


def verify_artifact_index(run_root: Path) -> list[dict[str, Any]]:
    """Compare current files with persisted hashes without modifying either."""
    index = read_json(run_root / ARTIFACT_FILES["index"], default={}) or {}
    expected = {
        item["filename"]: item
        for item in index.get("artifacts", [])
        if isinstance(item, dict) and item.get("filename")
    }
    results = []
    for current in artifact_inventory(run_root):
        reference = expected.get(current["filename"])
        if not current["exists"]:
            status = "missing"
        elif current["filename"] == ARTIFACT_FILES["index"]:
            # A hash index cannot include its own final hash without a circular value.
            status = "index"
        elif reference is None:
            status = "unindexed"
        elif reference.get("sha256") == current["sha256"]:
            status = "verified"
        else:
            status = "hash_mismatch"
        results.append({**current, "status": status})
    return results


def load_run(run_root: Path) -> dict[str, Any]:
    return {
        "manifest": read_json(run_root / ARTIFACT_FILES["manifest"], default={}) or {},
        "summary": read_json(run_root / ARTIFACT_FILES["summary"], default={}) or {},
        "records": read_jsonl(run_root / ARTIFACT_FILES["records"]),
        "claims": read_jsonl(run_root / ARTIFACT_FILES["claims"]),
        "candidates": read_jsonl(run_root / ARTIFACT_FILES["candidates"]),
        "labels": read_jsonl(run_root / ARTIFACT_FILES["labels"]),
        "unresolved": read_jsonl(run_root / ARTIFACT_FILES["unresolved"]),
        "review_sample": read_jsonl(run_root / ARTIFACT_FILES["review_sample"]),
        "review_decisions": read_jsonl(run_root / ARTIFACT_FILES["review_decisions"]),
    }


def calibration_funnel(run: dict[str, Any]) -> list[dict[str, Any]]:
    records = run["records"]
    claims = run["claims"]
    labels = run["labels"]
    unresolved = run["unresolved"]
    labeled_claims = {row.get("claim_id") for row in labels}
    unresolved_claims = {row.get("claim_id") for row in unresolved}
    return [
        {"stage": "sampled records", "count": len(records)},
        {"stage": "message-derived claims", "count": len(claims)},
        {"stage": "claims with code labels", "count": len(labeled_claims - {None})},
        {"stage": "emitted code-label datapoints", "count": len(labels)},
        {"stage": "unresolved claims", "count": len(unresolved_claims - {None})},
    ]


def group_by(rows: Iterable[dict[str, Any]], key: str) -> dict[Any, list[dict[str, Any]]]:
    grouped: dict[Any, list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(row.get(key), []).append(row)
    return grouped


def candidates_for_claim(run: dict[str, Any], claim_id: str) -> list[dict[str, Any]]:
    rows = [row for row in run["candidates"] if row.get("claim_id") == claim_id]
    return sorted(rows, key=lambda row: (
        row.get("enumeration_rank", row.get("queue_rank", 10**9)),
        row.get("candidate_id", ""),
    ))


queue_for_claim = candidates_for_claim


def record_bundle(run: dict[str, Any], record_id: str) -> dict[str, Any]:
    records = [row for row in run["records"] if row.get("record_id") == record_id]
    if not records:
        raise KeyError(f"Unknown record_id: {record_id}")
    claims = [row for row in run["claims"] if row.get("record_id") == record_id]
    claim_ids = {row.get("claim_id") for row in claims}
    return {
        "record": records[0],
        "claims": claims,
        "candidates": [row for row in run["candidates"] if row.get("claim_id") in claim_ids],
        "labels": [row for row in run["labels"] if row.get("claim_id") in claim_ids],
        "unresolved": [row for row in run["unresolved"] if row.get("claim_id") in claim_ids],
    }


def outcome_counts(run: dict[str, Any]) -> dict[str, int]:
    return dict(Counter(row.get("reason", "unclassified") for row in run["unresolved"]))


def _line_diff(before: str, after: str) -> list[tuple[str, str]]:
    before_lines = before.splitlines()
    after_lines = after.splitlines()
    matcher = SequenceMatcher(a=before_lines, b=after_lines, autojunk=False)
    output: list[tuple[str, str]] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            output.extend(("context", line) for line in before_lines[i1:i2])
        elif tag == "delete":
            output.extend(("remove", line) for line in before_lines[i1:i2])
        elif tag == "insert":
            output.extend(("add", line) for line in after_lines[j1:j2])
        else:
            output.extend(("remove", line) for line in before_lines[i1:i2])
            output.extend(("add", line) for line in after_lines[j1:j2])
    return output


def diff_html(before: str, after: str, context: int = 4) -> str:
    """Render a compact, line-highlighted diff suitable for IPython.display.HTML."""
    rows = _line_diff(before, after)
    changed = [index for index, (kind, _) in enumerate(rows) if kind != "context"]
    visible: set[int] = set()
    for index in changed:
        visible.update(range(max(0, index - context), min(len(rows), index + context + 1)))
    if not changed:
        visible.update(range(min(len(rows), context * 2 + 1)))

    fragments = [
        "<style>",
        ".ia-diff{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}",
        ".ia-diff-line{display:grid;grid-template-columns:2rem 1fr;white-space:pre-wrap}",
        ".ia-add{background:#16351f}.ia-remove{background:#451d22}.ia-context{opacity:.82}",
        ".ia-prefix{user-select:none;opacity:.75;padding-right:.5rem;text-align:center}",
        "</style><div class='ia-diff'>",
    ]
    last_visible = -2
    for index in sorted(visible):
        if index > last_visible + 1:
            fragments.append("<div class='ia-diff-line ia-context'><span class='ia-prefix'>…</span><span></span></div>")
        kind, line = rows[index]
        prefix = {"add": "+", "remove": "−", "context": " "}[kind]
        fragments.append(
            f"<div class='ia-diff-line ia-{kind}'><span class='ia-prefix'>{prefix}</span>"
            f"<span>{escape(line)}</span></div>"
        )
        last_visible = index
    fragments.append("</div>")
    return "".join(fragments)


def subtree_html(label_or_candidate: dict[str, Any]) -> str:
    source = label_or_candidate.get("source_text") or label_or_candidate.get("source_excerpt") or ""
    sexpr = label_or_candidate.get("ast_sexpr") or label_or_candidate.get("normalized_ast") or ""
    side = escape(str(label_or_candidate.get("side", "unknown")))
    node_type = escape(str(label_or_candidate.get("node_type", "unknown")))
    return (
        "<div><strong>"
        + side
        + " · "
        + node_type
        + "</strong><pre>"
        + escape(str(source))
        + "</pre><details><summary>AST</summary><pre>"
        + escape(str(sexpr))
        + "</pre></details></div>"
    )

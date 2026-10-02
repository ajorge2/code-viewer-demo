"""Immutable, content-addressed artifacts for Intent Algebra experiment runs."""

from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
from typing import Any, Iterable
from uuid import uuid4


SCHEMA_VERSION = "intent-algebra-audit/v1"
INDEX_FILENAME = "artifact-index.json"


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def stable_id(prefix: str, *identity_parts: Any) -> str:
    """Create a reproducible opaque ID from semantic identity, not row position alone."""
    digest = sha256(canonical_json(identity_parts).encode("utf-8")).hexdigest()[:24]
    return f"{prefix}_{digest}"


def file_sha256(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _atomic_write(path: Path, text: str) -> None:
    if path.exists():
        raise FileExistsError(f"Refusing to overwrite immutable artifact: {path}")
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"Expected object at {path}:{line_number}")
            rows.append(value)
    return rows


class AuditRunWriter:
    """Writes a run once, validates its links, then seals it with file hashes."""

    def __init__(self, run_root: Path, manifest: dict[str, Any]):
        self.run_root = Path(run_root)
        self.run_root.mkdir(parents=True, exist_ok=True)
        if any(self.run_root.iterdir()):
            raise FileExistsError(f"Run directory must be empty: {self.run_root}")
        persisted_manifest = {
            "schema_version": SCHEMA_VERSION,
            "created_at": datetime.now(timezone.utc).isoformat(),
            **manifest,
        }
        self.write_json("run-manifest.json", persisted_manifest)

    def write_json(self, filename: str, value: Any) -> Path:
        self._ensure_open()
        path = self.run_root / filename
        _atomic_write(path, json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
        return path

    def write_jsonl(self, filename: str, rows: Iterable[dict[str, Any]]) -> Path:
        self._ensure_open()
        materialized = list(rows)
        body = "".join(canonical_json(row) + "\n" for row in materialized)
        path = self.run_root / filename
        _atomic_write(path, body)
        return path

    def validate_links(self) -> dict[str, int]:
        records = _read_jsonl(self.run_root / "records.jsonl")
        claims = _read_jsonl(self.run_root / "claims.jsonl")
        candidates = _read_jsonl(self.run_root / "ast-candidates.jsonl")
        labels = _read_jsonl(self.run_root / "code-labels.jsonl")
        unresolved = _read_jsonl(self.run_root / "unresolved.jsonl")

        record_ids = self._unique_ids(records, "record_id", "records")
        claim_ids = self._unique_ids(claims, "claim_id", "claims")
        candidate_ids = self._unique_ids(candidates, "candidate_id", "candidates")
        self._unique_ids(labels, "label_id", "labels")

        self._require_foreign_keys(claims, "record_id", record_ids, "claims → records")
        self._require_foreign_keys(candidates, "claim_id", claim_ids, "candidates → claims")
        self._require_foreign_keys(labels, "claim_id", claim_ids, "labels → claims")
        self._require_foreign_keys(labels, "candidate_id", candidate_ids, "labels → candidates")
        self._require_foreign_keys(unresolved, "claim_id", claim_ids, "unresolved → claims")

        candidates_by_id = {row["candidate_id"]: row for row in candidates}
        for row in candidates:
            if row.get("side") not in {"before", "after"}:
                raise ValueError(f"Candidate {row['candidate_id']} must identify one diff side")
        for row in labels:
            candidate = candidates_by_id[row["candidate_id"]]
            if row.get("side") not in {"before", "after"}:
                raise ValueError(f"Label {row['label_id']} must identify one diff side")
            if row.get("side") != candidate.get("side"):
                raise ValueError(f"Label {row['label_id']} side does not match its candidate")

        resolved = {row["claim_id"] for row in labels}
        rejected = {row["claim_id"] for row in unresolved}
        if resolved & rejected:
            overlap = sorted(resolved & rejected)[:5]
            raise ValueError(f"Claims cannot be both resolved and unresolved: {overlap}")

        return {
            "records": len(records),
            "claims": len(claims),
            "candidates": len(candidates),
            "labels": len(labels),
            "unresolved": len(unresolved),
        }

    def finalize(self) -> Path:
        self._ensure_open()
        counts = self.validate_links()
        artifacts = []
        for path in sorted(self.run_root.iterdir()):
            if not path.is_file() or path.name == INDEX_FILENAME or path.name.startswith("."):
                continue
            row_count = None
            if path.suffix == ".jsonl":
                with path.open(encoding="utf-8") as handle:
                    row_count = sum(1 for line in handle if line.strip())
            artifacts.append(
                {
                    "filename": path.name,
                    "bytes": path.stat().st_size,
                    "rows": row_count,
                    "sha256": file_sha256(path),
                }
            )
        index = {
            "schema_version": SCHEMA_VERSION,
            "sealed_at": datetime.now(timezone.utc).isoformat(),
            "linkage_counts": counts,
            "artifacts": artifacts,
        }
        return self.write_json(INDEX_FILENAME, index)

    def _ensure_open(self) -> None:
        if (self.run_root / INDEX_FILENAME).exists():
            raise RuntimeError(f"Run is sealed and cannot be changed: {self.run_root}")

    @staticmethod
    def _unique_ids(rows: list[dict[str, Any]], field: str, label: str) -> set[str]:
        values = []
        for row_number, row in enumerate(rows, start=1):
            value = row.get(field)
            if not isinstance(value, str) or not value:
                raise ValueError(f"Missing {field} in {label} row {row_number}")
            values.append(value)
        if len(values) != len(set(values)):
            raise ValueError(f"Duplicate {field} in {label}")
        return set(values)

    @staticmethod
    def _require_foreign_keys(
        rows: list[dict[str, Any]], field: str, valid: set[str], relationship: str
    ) -> None:
        missing = sorted({row.get(field) for row in rows if row.get(field) not in valid})
        if missing:
            raise ValueError(f"Broken {relationship} links: {missing[:5]}")

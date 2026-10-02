import json
from pathlib import Path
import tempfile
import unittest

import audit_notebook as audit


class AuditNotebookTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.run_root = Path(self.tempdir.name)

    def tearDown(self):
        self.tempdir.cleanup()

    def write_jsonl(self, filename, rows):
        body = "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows)
        (self.run_root / filename).write_text(body, encoding="utf-8")

    def test_record_bundle_preserves_traceability(self):
        self.write_jsonl("records.jsonl", [{"record_id": "r1"}, {"record_id": "r2"}])
        self.write_jsonl(
            "claims.jsonl",
            [
                {"record_id": "r1", "claim_id": "c1"},
                {"record_id": "r1", "claim_id": "c2"},
                {"record_id": "r2", "claim_id": "c3"},
            ],
        )
        self.write_jsonl(
            "ast-candidates.jsonl",
            [
                {"claim_id": "c1", "candidate_id": "a1", "queue_rank": 2},
                {"claim_id": "c1", "candidate_id": "a2", "queue_rank": 1},
                {"claim_id": "c3", "candidate_id": "a3", "queue_rank": 1},
            ],
        )
        self.write_jsonl("code-labels.jsonl", [{"claim_id": "c1", "candidate_id": "a2"}])

        run = audit.load_run(self.run_root)
        bundle = audit.record_bundle(run, "r1")

        self.assertEqual([row["claim_id"] for row in bundle["claims"]], ["c1", "c2"])
        self.assertEqual({row["candidate_id"] for row in bundle["candidates"]}, {"a1", "a2"})
        self.assertEqual(audit.queue_for_claim(run, "c1")[0]["candidate_id"], "a2")

    def test_artifact_index_detects_hash_changes(self):
        records = self.run_root / "records.jsonl"
        records.write_text('{"record_id":"r1"}\n', encoding="utf-8")
        index = {
            "artifacts": [
                {
                    "filename": "records.jsonl",
                    "sha256": audit.file_sha256(records),
                }
            ]
        }
        (self.run_root / "artifact-index.json").write_text(json.dumps(index), encoding="utf-8")

        first = {row["filename"]: row for row in audit.verify_artifact_index(self.run_root)}
        self.assertEqual(first["records.jsonl"]["status"], "verified")

        records.write_text('{"record_id":"changed"}\n', encoding="utf-8")
        second = {row["filename"]: row for row in audit.verify_artifact_index(self.run_root)}
        self.assertEqual(second["records.jsonl"]["status"], "hash_mismatch")

    def test_funnel_counts_claims_and_single_sided_labels(self):
        run = {
            "records": [{"record_id": "r1"}],
            "claims": [{"claim_id": "c1"}, {"claim_id": "c2"}],
            "labels": [
                {"claim_id": "c1", "side": "before"},
                {"claim_id": "c1", "side": "after"},
            ],
            "unresolved": [{"claim_id": "c2", "reason": "no_supported_candidate"}],
        }
        counts = {row["stage"]: row["count"] for row in audit.calibration_funnel(run)}
        self.assertEqual(counts["claims with code labels"], 1)
        self.assertEqual(counts["emitted code-label datapoints"], 2)
        self.assertEqual(counts["unresolved claims"], 1)

    def test_diff_renderer_escapes_source_and_marks_both_sides(self):
        html = audit.diff_html("x = '<old>'", "x = '<new>'")
        self.assertIn("ia-remove", html)
        self.assertIn("ia-add", html)
        self.assertIn("&lt;old&gt;", html)
        self.assertIn("&lt;new&gt;", html)


if __name__ == "__main__":
    unittest.main()

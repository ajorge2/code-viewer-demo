import json
from pathlib import Path
import tempfile
import unittest

from audit_artifacts import AuditRunWriter, stable_id


class AuditArtifactTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.run_root = Path(self.tempdir.name) / "run"

    def tearDown(self):
        self.tempdir.cleanup()

    def valid_rows(self):
        record_id = stable_id("rec", "dataset", "python", "source-1")
        claim_id = stable_id("clm", record_id, 0, "add", "input validation")
        candidate_id = stable_id("ast", claim_id, "after", "function_definition:0:20")
        label_id = stable_id("lbl", claim_id, candidate_id)
        return {
            "records": [{"record_id": record_id}],
            "claims": [{"claim_id": claim_id, "record_id": record_id}],
            "candidates": [
                {
                    "candidate_id": candidate_id,
                    "claim_id": claim_id,
                    "side": "after",
                }
            ],
            "labels": [
                {
                    "label_id": label_id,
                    "claim_id": claim_id,
                    "candidate_id": candidate_id,
                    "side": "after",
                }
            ],
        }

    def write_valid_run(self, writer, rows):
        writer.write_jsonl("records.jsonl", rows["records"])
        writer.write_jsonl("claims.jsonl", rows["claims"])
        writer.write_jsonl("ast-candidates.jsonl", rows["candidates"])
        writer.write_jsonl("code-labels.jsonl", rows["labels"])
        writer.write_jsonl("unresolved.jsonl", [])

    def test_finalize_hashes_and_seals_run(self):
        writer = AuditRunWriter(self.run_root, {"run_id": "test-run", "seed": 7})
        self.write_valid_run(writer, self.valid_rows())

        index_path = writer.finalize()
        index = json.loads(index_path.read_text(encoding="utf-8"))

        self.assertEqual(index["linkage_counts"]["labels"], 1)
        self.assertIn("records.jsonl", {row["filename"] for row in index["artifacts"]})
        with self.assertRaises(RuntimeError):
            writer.write_json("late.json", {})

    def test_refuses_silent_overwrite(self):
        writer = AuditRunWriter(self.run_root, {"run_id": "test-run"})
        writer.write_jsonl("records.jsonl", [])
        with self.assertRaises(FileExistsError):
            writer.write_jsonl("records.jsonl", [])

    def test_rejects_broken_candidate_link(self):
        writer = AuditRunWriter(self.run_root, {"run_id": "test-run"})
        rows = self.valid_rows()
        rows["labels"][0]["candidate_id"] = "ast_missing"
        self.write_valid_run(writer, rows)
        with self.assertRaisesRegex(ValueError, "labels → candidates"):
            writer.finalize()

    def test_rejects_paired_or_unknown_side(self):
        writer = AuditRunWriter(self.run_root, {"run_id": "test-run"})
        rows = self.valid_rows()
        rows["candidates"][0]["side"] = "before_after"
        rows["labels"][0]["side"] = "before_after"
        self.write_valid_run(writer, rows)
        with self.assertRaisesRegex(ValueError, "one diff side"):
            writer.finalize()

    def test_stable_ids_are_deterministic_and_namespaced(self):
        self.assertEqual(stable_id("rec", "x", 1), stable_id("rec", "x", 1))
        self.assertNotEqual(stable_id("rec", "x", 1), stable_id("clm", "x", 1))


if __name__ == "__main__":
    unittest.main()

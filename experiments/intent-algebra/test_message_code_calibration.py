import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).with_name("run-message-code-calibration.py")
SPEC = importlib.util.spec_from_file_location("message_code_calibration", MODULE_PATH)
calibration = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(calibration)


def candidate(key, base_rank, sign, side="after"):
    return {
        "candidate_key": key,
        "base_rank": base_rank,
        "queue_sign": sign,
        "side": side,
    }


class CandidateOrderingTests(unittest.TestCase):
    def test_clear_add_verb_creates_only_matching_and_nonmatching_buckets(self):
        claim = {"effective_verb_sign": "add"}
        rows = calibration.order_candidates(
            claim,
            [
                candidate("neutral-first", 0, "neutral"),
                candidate("add-later", 1, "add"),
                candidate("remove-last", 2, "remove"),
            ],
            "claim-1",
        )
        self.assertEqual([row["queue_sign"] for row in rows], ["add", "neutral", "remove"])
        self.assertEqual([row["sign_bucket"] for row in rows], [0, 1, 1])

    def test_neutral_verb_skips_sign_buckets_and_preserves_structural_order(self):
        claim = {"effective_verb_sign": "neutral"}
        rows = calibration.order_candidates(
            claim,
            [candidate("remove", 2, "remove"), candidate("add", 0, "add")],
            "claim-2",
        )
        self.assertEqual([row["candidate_key"] for row in rows], ["add", "remove"])
        self.assertEqual([row["sign_bucket"] for row in rows], [None, None])

    def test_candidate_ids_are_claim_specific(self):
        source = [candidate("same-node", 0, "add")]
        left = calibration.order_candidates({"effective_verb_sign": "add"}, source, "claim-a")
        right = calibration.order_candidates({"effective_verb_sign": "add"}, source, "claim-b")
        self.assertNotEqual(left[0]["candidate_id"], right[0]["candidate_id"])


if __name__ == "__main__":
    unittest.main()

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


def scored_candidate(candidate_id, queue_rank, side="after"):
    return {
        "candidate_id": candidate_id,
        "queue_rank": queue_rank,
        "side": side,
        "node_type": "expression_statement",
        "roles": ["direct_edit"],
        "queue_sign": "add",
        "source_excerpt": "x = 1",
        "ast_sexpr": "(expression_statement (assignment))",
    }


class FakeAlignmentCache:
    def __init__(self, evaluations):
        self.evaluations = evaluations

    def request(self, _prompt, _schema, _schema_name):
        return {"evaluations": self.evaluations}, {
            "response_id": "response-1",
            "cache_key": "cache-1",
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


class MultiDatapointAlignmentTests(unittest.TestCase):
    def test_every_independently_supported_candidate_above_threshold_is_emitted(self):
        candidates = [
            scored_candidate("candidate-a", 0),
            scored_candidate("candidate-b", 1),
            scored_candidate("candidate-c", 2),
        ]
        cache = FakeAlignmentCache([
            {"candidate_id": "candidate-a", "relation": "supports", "alignment_confidence": 0.91, "reason": "exact"},
            {"candidate_id": "candidate-b", "relation": "supports", "alignment_confidence": 0.81, "reason": "also exact"},
            {"candidate_id": "candidate-c", "relation": "partial", "alignment_confidence": 0.96, "reason": "needs parent"},
        ])

        accepted, _calls, unresolved = calibration.evaluate_queue(
            cache,
            {"message": "add two handlers"},
            {"canonical_verb": "add", "effective_verb_sign": "add", "object_phrase": "handlers"},
            candidates,
            batch_size=8,
            minimum_confidence=0.75,
        )

        self.assertEqual([row["candidate_id"] for row in accepted], ["candidate-a", "candidate-b"])
        self.assertIsNone(unresolved)
        self.assertEqual(candidates[2]["decision"], "not_independent_support")

    def test_supported_candidates_below_threshold_leave_claim_unresolved(self):
        candidates = [scored_candidate("candidate-a", 0)]
        cache = FakeAlignmentCache([
            {"candidate_id": "candidate-a", "relation": "supports", "alignment_confidence": 0.70, "reason": "weak"},
        ])

        accepted, _calls, unresolved = calibration.evaluate_queue(
            cache,
            {"message": "add a handler"},
            {"canonical_verb": "add", "effective_verb_sign": "add", "object_phrase": "handler"},
            candidates,
            batch_size=8,
            minimum_confidence=0.75,
        )

        self.assertEqual(accepted, [])
        self.assertEqual(unresolved, "supported_candidates_below_confidence_threshold")
        self.assertEqual(candidates[0]["decision"], "below_confidence_threshold")


if __name__ == "__main__":
    unittest.main()

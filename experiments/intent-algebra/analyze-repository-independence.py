#!/usr/bin/env python3
"""Estimate repository-family support from observed CommitPackFT provenance.

Each file-pair row can name several repositories because CommitPackFT associates
identical code with forks or mirrors. A row therefore counts once, never once per
repository name. Rows that share any repository name are additionally collapsed into
one observed provenance component. Disjoint fork families, cherry-picks, and renamed
mirrors remain invisible without external enrichment, so this is a promotion proxy,
not proof of independence.
"""

from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rules", type=Path, required=True)
    parser.add_argument("--refinement", type=Path, required=True)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--semantic-expansions", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--minimum-commits", type=int, default=100)
    parser.add_argument("--minimum-repository-families", type=int, default=50)
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def repository_names(sample: dict) -> set[str]:
    return {
        value.strip()
        for value in str(sample.get("repos", "")).split(",")
        if value.strip()
    }


class UnionFind:
    def __init__(self, values: set[str]):
        self.parent = {value: value for value in values}

    def find(self, value: str) -> str:
        root = value
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[value] != value:
            value, self.parent[value] = self.parent[value], root
        return root

    def union(self, left: str, right: str) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root != right_root:
            self.parent[right_root] = left_root


def expansion_members(path: Path | None) -> dict[str, set[str]]:
    if path is None:
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    return {
        category["node_id"]: {
            candidate["sample_id"]
            for candidate in category.get("candidates", [])
            if candidate.get("decision") == "provisional_expand"
        }
        for category in payload.get("categories", [])
    }


def provenance_components(member_ids: set[str], samples: dict[str, dict]) -> tuple[list[dict], dict]:
    union_find = UnionFind(member_ids)
    owner_by_repository: dict[str, str] = {}
    repositories_by_sample: dict[str, set[str]] = {}
    for sample_id in member_ids:
        repositories = repository_names(samples[sample_id])
        repositories_by_sample[sample_id] = repositories
        for repository in repositories:
            owner = owner_by_repository.get(repository)
            if owner is None:
                owner_by_repository[repository] = sample_id
            else:
                union_find.union(sample_id, owner)

    sample_ids_by_root: dict[str, set[str]] = {}
    for sample_id in member_ids:
        sample_ids_by_root.setdefault(union_find.find(sample_id), set()).add(sample_id)
    components = []
    for index, sample_ids in enumerate(
        sorted(sample_ids_by_root.values(), key=lambda values: (-len(values), sorted(values)[0])),
        start=1,
    ):
        repositories = sorted({
            repository
            for sample_id in sample_ids
            for repository in repositories_by_sample[sample_id]
        })
        components.append({
            "component_id": f"REPO_FAMILY_{index:04d}",
            "sample_count": len(sample_ids),
            "repository_name_count": len(repositories),
            "sample_ids": sorted(sample_ids),
            "repository_names": repositories,
        })
    all_repositories = set(owner_by_repository)
    summary = {
        "observed_repository_name_count": len(all_repositories),
        "observed_provenance_component_count": len(components),
        "largest_component_sample_count": max((item["sample_count"] for item in components), default=0),
        "singleton_component_count": sum(item["sample_count"] == 1 for item in components),
        "multi_repository_sample_count": sum(len(values) > 1 for values in repositories_by_sample.values()),
        "maximum_repository_names_on_one_sample": max((len(values) for values in repositories_by_sample.values()), default=0),
        "samples_without_repository_names": sum(not values for values in repositories_by_sample.values()),
    }
    return components, summary


def main() -> None:
    args = parse_args()
    rules = json.loads(args.rules.read_text(encoding="utf-8"))
    refinement = {
        node["node_id"]: node
        for node in json.loads(args.refinement.read_text(encoding="utf-8"))["nodes"]
    }
    samples = {sample["sample_id"]: sample for sample in read_jsonl(args.samples)}
    additions = expansion_members(args.semantic_expansions)
    categories = []
    for rule in rules["categories"]:
        node_id = rule["node_id"]
        original_ids = set(refinement[node_id]["hard_member_ids"])
        added_ids = additions.get(node_id, set())
        member_ids = original_ids | added_ids
        components, provenance = provenance_components(member_ids, samples)
        passes_commit = len(member_ids) >= args.minimum_commits
        passes_families = provenance["observed_provenance_component_count"] >= args.minimum_repository_families
        categories.append({
            "node_id": node_id,
            "meaning": rule["meaning"],
            "semantic_member_count": len(member_ids),
            "original_member_count": len(original_ids),
            "audited_expansion_count": len(added_ids),
            **provenance,
            "passes_commit_frequency_proxy": passes_commit,
            "passes_observed_repository_family_proxy": passes_families,
            "passes_both_support_proxies": passes_commit and passes_families,
            "components": components,
        })
    status_counts = Counter(
        "passes_both" if item["passes_both_support_proxies"] else "insufficient"
        for item in categories
    )
    payload = {
        "method": "collapse each CommitPackFT row to one unit, then union rows sharing any repository name",
        "interpretation": "observed provenance components are a conservative correction for known aliases but cannot prove repository independence",
        "unresolved_risks": [
            "forks or mirrors with disjoint repository names",
            "cherry-picked equivalent commits with different SHAs",
            "renamed repositories not linked in the bucket metadata",
            "missing commit-wide changed-file context",
        ],
        "thresholds": {
            "minimum_patch_distinct_commits": args.minimum_commits,
            "minimum_observed_provenance_components": args.minimum_repository_families,
        },
        "status_counts": dict(sorted(status_counts.items())),
        "categories": categories,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    passing = [item for item in categories if item["passes_both_support_proxies"]]
    print(f"Analyzed {len(categories)} categories; {len(passing)} pass both observed support proxies")
    for item in passing:
        print(
            f"{item['meaning']}: commits={item['semantic_member_count']}, "
            f"observed provenance components={item['observed_provenance_component_count']}, "
            f"repository names={item['observed_repository_name_count']}"
        )


if __name__ == "__main__":
    main()

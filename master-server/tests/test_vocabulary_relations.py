import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import core.review_vocabulary as review_vocabulary
from api.review_routes import (
    RelationSuggestRequest,
    SplitApplyRequest,
    VocabSaveRequest,
    VocabRenameRequest,
    apply_split,
    rename_vocab,
    review_visualization,
    save_vocab,
    suggest_vocab_relations,
)


def write_vocab(root: Path, category: str, filename: str, payload: dict) -> None:
    category_dir = root / category
    category_dir.mkdir(parents=True, exist_ok=True)
    review_vocabulary.save_vocab_file(str(category_dir / filename), payload)


class VocabularyRelationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.vocab_patch = patch.object(review_vocabulary, "VOCAB_DIR", str(self.root))
        self.vocab_patch.start()

    def tearDown(self):
        self.vocab_patch.stop()
        self.tmp.cleanup()

    def test_rename_preserves_display_word_spaces_when_filename_slug_matches(self):
        write_vocab(
            self.root,
            "daily",
            "go-off-tone.json",
            {
                "word": "go-off-tone",
                "createdAt": "2026-04-29",
                "reviews": [],
                "definitions": ["走调"],
                "examples": [{"text": "going off tone", "focusWords": ["go-off-tone"]}],
            },
        )

        body = rename_vocab(
            VocabRenameRequest(
                category="daily",
                filename="go-off-tone.json",
                word="go off tone",
                data={
                    "word": "go off tone",
                    "createdAt": "2026-04-29",
                    "reviews": [],
                    "definitions": ["走调"],
                    "examples": [{"text": "going off tone", "focusWords": ["go off tone"]}],
                },
            )
        )

        self.assertEqual(body["file"], "go-off-tone.json")
        self.assertEqual(body["data"]["word"], "go off tone")
        saved = review_vocabulary.load_vocab_file(str(self.root / "daily" / "go-off-tone.json"))
        self.assertEqual(saved["word"], "go off tone")

    def test_split_keeps_source_target_and_creates_bidirectional_edges(self):
        write_vocab(
            self.root,
            "daily",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-17",
                "reviews": [{"date": "2026-05-20", "score": 3}],
                "definitions": ["危害；危险；风险"],
                "examples": [
                    {
                        "text": "Pesticides create hazards for farmworkers.",
                        "explanation": "hazards 指风险。",
                        "focusWords": ["hazards"],
                    },
                    {
                        "text": "Do you want to hazard a guess?",
                        "explanation": "hazard a guess 是固定表达。",
                        "focusWords": ["hazard"],
                    },
                ],
            },
        )

        body = apply_split(
            SplitApplyRequest(
                category="daily",
                source_filename="hazard.json",
                delete_source=True,
                suggestion={
                    "action": "split",
                    "reason": "名词 hazard 和固定短语 hazard a guess 应分开。",
                    "suggested_entries": [
                        {
                            "word": "hazard",
                            "definitions": ["危害；危险；风险"],
                            "focus_words": ["hazards"],
                            "example_indices": [0],
                        },
                        {
                            "word": "hazard a guess",
                            "definitions": ["冒昧猜一下；试着猜一猜"],
                            "focus_words": ["hazard a guess"],
                            "example_indices": [1],
                        },
                    ],
                },
            )
        )

        self.assertFalse(body["source_deleted"])
        self.assertTrue((self.root / "daily" / "hazard.json").exists())
        self.assertTrue((self.root / "daily" / "hazard-a-guess.json").exists())

        hazard = review_vocabulary.load_vocab_file(str(self.root / "daily" / "hazard.json"))
        phrase = review_vocabulary.load_vocab_file(str(self.root / "daily" / "hazard-a-guess.json"))
        self.assertEqual(hazard["word"], "hazard")
        self.assertEqual(phrase["word"], "hazard a guess")
        self.assertEqual(hazard["reviews"], [{"date": "2026-05-20", "score": 3}])
        self.assertEqual(hazard["examples"][0]["focusWords"], ["hazards"])
        self.assertEqual(phrase["examples"][0]["focusWords"], ["hazard a guess"])
        self.assertEqual(hazard["relations"][0]["target"]["file"], "hazard-a-guess.json")
        self.assertEqual(phrase["relations"][0]["target"]["file"], "hazard.json")

    def test_visualization_graph_includes_json_and_cross_category_same_word_edges(self):
        write_vocab(
            self.root,
            "daily",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-17",
                "reviews": [],
                "definitions": ["危害"],
                "examples": [],
                "relations": [
                    {
                        "type": "split",
                        "target": {
                            "category": "daily",
                            "file": "hazard-a-guess.json",
                            "word": "hazard a guess",
                        },
                    }
                ],
            },
        )
        write_vocab(
            self.root,
            "daily",
            "hazard-a-guess.json",
            {
                "word": "hazard a guess",
                "createdAt": "2026-05-17",
                "reviews": [],
                "definitions": ["试着猜"],
                "examples": [],
            },
        )
        write_vocab(
            self.root,
            "cet",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-18",
                "reviews": [],
                "definitions": ["风险"],
                "examples": [],
            },
        )

        graph = review_visualization()["graph"]
        self.assertEqual(graph["component_count"], 1)
        component = graph["components"][0]
        node_ids = {node["id"] for node in component["nodes"]}
        self.assertEqual(
            node_ids,
            {"daily/hazard.json", "daily/hazard-a-guess.json", "cet/hazard.json"},
        )
        scopes = {edge["scope"] for edge in component["edges"]}
        self.assertIn("same_category", scopes)
        self.assertIn("cross_category", scopes)

    def test_save_normalizes_relation_aliases_and_syncs_reverse_edge(self):
        write_vocab(
            self.root,
            "daily",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-17",
                "reviews": [],
                "definitions": ["危害"],
                "examples": [],
            },
        )
        write_vocab(
            self.root,
            "daily",
            "hazard-a-guess.json",
            {
                "word": "hazard a guess",
                "createdAt": "2026-05-18",
                "reviews": [],
                "definitions": ["试着猜"],
                "examples": [],
            },
        )

        body = save_vocab(
            VocabSaveRequest(
                category="daily",
                filename="hazard.json",
                data={
                    "word": "hazard",
                    "createdAt": "2026-05-17",
                    "reviews": [],
                    "definitions": ["危害"],
                    "examples": [],
                    "links": [
                        {
                            "type": "phrase",
                            "target": {
                                "category": "daily",
                                "file": "hazard-a-guess.json",
                                "word": "hazard a guess",
                            },
                            "reason": "固定短语",
                        }
                    ],
                },
            )
        )

        self.assertIn("relations", body["data"])
        self.assertNotIn("links", body["data"])
        phrase = review_vocabulary.load_vocab_file(str(self.root / "daily" / "hazard-a-guess.json"))
        self.assertEqual(phrase["relations"][0]["target"]["file"], "hazard.json")
        self.assertEqual(phrase["relations"][0]["type"], "phrase")

    def test_save_relation_removal_clears_reverse_edge(self):
        write_vocab(
            self.root,
            "daily",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-17",
                "reviews": [],
                "definitions": ["危害"],
                "examples": [],
                "relations": [
                    {
                        "type": "phrase",
                        "target": {
                            "category": "daily",
                            "file": "hazard-a-guess.json",
                            "word": "hazard a guess",
                        },
                    }
                ],
            },
        )
        write_vocab(
            self.root,
            "daily",
            "hazard-a-guess.json",
            {
                "word": "hazard a guess",
                "createdAt": "2026-05-18",
                "reviews": [],
                "definitions": ["试着猜"],
                "examples": [],
                "relations": [
                    {
                        "type": "phrase",
                        "target": {
                            "category": "daily",
                            "file": "hazard.json",
                            "word": "hazard",
                        },
                    }
                ],
            },
        )

        save_vocab(
            VocabSaveRequest(
                category="daily",
                filename="hazard.json",
                data={
                    "word": "hazard",
                    "createdAt": "2026-05-17",
                    "reviews": [],
                    "definitions": ["危害"],
                    "examples": [],
                    "relations": [],
                },
            )
        )

        hazard = review_vocabulary.load_vocab_file(str(self.root / "daily" / "hazard.json"))
        phrase = review_vocabulary.load_vocab_file(str(self.root / "daily" / "hazard-a-guess.json"))
        self.assertNotIn("relations", hazard)
        self.assertNotIn("relations", phrase)

    def test_relation_suggest_endpoint_uses_dedicated_llm_and_filters_candidates(self):
        write_vocab(
            self.root,
            "daily",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-17",
                "reviews": [],
                "definitions": ["危害"],
                "examples": [{"text": "Do you want to hazard a guess?"}],
            },
        )
        write_vocab(
            self.root,
            "daily",
            "hazard-a-guess.json",
            {
                "word": "hazard a guess",
                "createdAt": "2026-05-18",
                "reviews": [],
                "definitions": ["试着猜"],
                "examples": [],
            },
        )
        write_vocab(
            self.root,
            "cet",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-19",
                "reviews": [],
                "definitions": ["风险"],
                "examples": [],
            },
        )

        with patch("api.review_routes.suggest_vocab_relations_with_llm") as mocked:
            mocked.return_value = {
                "suggestions": [
                    {
                        "type": "phrase",
                        "target": {
                            "category": "daily",
                            "file": "hazard-a-guess.json",
                            "word": "hazard a guess",
                        },
                        "reason": "固定短语",
                        "confidence": 0.91,
                    }
                ],
                "notes": [],
            }
            body = suggest_vocab_relations(
                RelationSuggestRequest(
                    category="daily",
                    filename="hazard.json",
                    limit=8,
                )
            )

        mocked.assert_called_once()
        self.assertEqual(body["status"], "success")
        self.assertGreaterEqual(body["meta"]["candidate_count"], 2)
        targets = {
            (item["type"], item["target"]["category"], item["target"]["file"])
            for item in body["suggestions"]
        }
        self.assertIn(("phrase", "daily", "hazard-a-guess.json"), targets)
        self.assertIn(("same_word", "cet", "hazard.json"), targets)


if __name__ == "__main__":
    unittest.main()

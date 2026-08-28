import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from core import vocabulary
from api import review_routes
import core.review_vocabulary as review_vocabulary
from core.vocabulary_redirects import save_redirect
from api.routes import get_vocab_detail
from core.vocabulary_quality import vocabulary_entry_needs_processing


class VocabularyMergeTests(unittest.TestCase):
    def test_duplicate_context_refreshes_source_after_task_rename(self):
        context = "The same context should stay as one example."

        with TemporaryDirectory() as tmp_dir:
            with patch.object(vocabulary, "VOCAB_DIR", str(Path(tmp_dir))):
                vocabulary.merge_or_create_vocab(
                    word="alpha",
                    context=context,
                    source_name="资源解析任务",
                    llm_generated_data={
                        "definitions": ["n. alpha"],
                        "examples": [
                            {
                                "text": context,
                                "explanation": "old explanation",
                                "focusWords": ["alpha"],
                            },
                        ],
                    },
                    category="daily",
                )

                merged = vocabulary.merge_or_create_vocab(
                    word="alpha",
                    context=context,
                    source_name="CET6 23 12 2 阅读2",
                    source_url="https://example.test/tasks/renamed",
                    llm_generated_data={
                        "examples": [
                            {
                                "text": context,
                                "explanation": "new explanation",
                                "focusWords": ["same context"],
                            },
                        ],
                    },
                    category="daily",
                    focus_positions=[4, 2, 2],
                )

                examples = merged["examples"]
                self.assertEqual(len(examples), 1)
                self.assertEqual(examples[0]["source"]["text"], "CET6 23 12 2 阅读2")
                self.assertEqual(examples[0]["source"]["url"], "https://example.test/tasks/renamed")
                self.assertEqual(examples[0]["explanation"], "new explanation")
                self.assertEqual(examples[0]["focusWords"], ["same context"])
                self.assertEqual(examples[0]["focusPositions"], [2, 4])

                loaded = vocabulary.load_vocab("alpha", "daily")
                self.assertEqual(loaded["examples"][0]["source"]["text"], "CET6 23 12 2 阅读2")

    def test_placeholder_source_does_not_replace_specific_source(self):
        context = "Existing source should remain specific."

        with TemporaryDirectory() as tmp_dir:
            with patch.object(vocabulary, "VOCAB_DIR", str(Path(tmp_dir))):
                vocabulary.merge_or_create_vocab(
                    word="beta",
                    context=context,
                    source_name="剑桥 5 1 阅读3",
                    category="ielts",
                )

                merged = vocabulary.merge_or_create_vocab(
                    word="beta",
                    context=context,
                    source_name="资源解析任务",
                    category="ielts",
                )

                self.assertEqual(len(merged["examples"]), 1)
                self.assertEqual(merged["examples"][0]["source"]["text"], "剑桥 5 1 阅读3")

    def test_intentional_blank_marks_new_and_existing_examples(self):
        context = "The answer option is ____ in this cloze sentence."

        with TemporaryDirectory() as tmp_dir:
            with patch.object(vocabulary, "VOCAB_DIR", str(Path(tmp_dir))):
                first = vocabulary.merge_or_create_vocab(
                    word="gamma",
                    context=context,
                    source_name="CET6 23 12 3 完形",
                    category="cet",
                    intentional_blank=True,
                )

                self.assertTrue(first["examples"][0]["intentionalBlank"])

                vocabulary.merge_or_create_vocab(
                    word="delta",
                    context=context,
                    source_name="CET6 23 12 3 完形",
                    category="cet",
                )
                merged = vocabulary.merge_or_create_vocab(
                    word="delta",
                    context=context,
                    source_name="CET6 23 12 3 完形",
                    category="cet",
                    intentional_blank=True,
                )

                self.assertEqual(len(merged["examples"]), 1)
                self.assertTrue(merged["examples"][0]["intentionalBlank"])

    def test_intentional_blank_can_store_empty_example_text(self):
        with TemporaryDirectory() as tmp_dir:
            with patch.object(vocabulary, "VOCAB_DIR", str(Path(tmp_dir))):
                merged = vocabulary.merge_or_create_vocab(
                    word="epsilon",
                    context="",
                    source_name="CET6 23 12 3 完形",
                    category="cet",
                    intentional_blank=True,
                )

                self.assertEqual(len(merged["examples"]), 1)
                self.assertEqual(merged["examples"][0]["text"], "")
                self.assertEqual(merged["examples"][0]["explanation"], "")
                self.assertTrue(merged["examples"][0]["intentionalBlank"])

    def test_quality_scan_ignores_intentional_blank_example_explanation(self):
        self.assertFalse(
            vocabulary_entry_needs_processing(
                {
                    "word": "blank",
                    "definitions": ["空格；留白"],
                    "examples": [
                        {
                            "text": "The answer option is ____.",
                            "explanation": "",
                            "intentionalBlank": True,
                        }
                    ],
                }
            )
        )

    def test_detail_lookup_follows_merge_redirect(self):
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            with (
                patch.object(vocabulary, "VOCAB_DIR", str(root)),
                patch.object(review_vocabulary, "VOCAB_DIR", str(root)),
            ):
                vocabulary.merge_or_create_vocab(
                    word="shatter",
                    context="",
                    source_name="",
                    category="daily",
                )
                save_redirect(
                    source_category="daily",
                    source_filename="shatters.json",
                    source_word="shatters",
                    target_category="daily",
                    target_filename="shatter.json",
                    target_word="shatter",
                    reason="rename_merge",
                )

                result = get_vocab_detail("shatters.json", "daily")

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["category"], "daily")
        self.assertEqual(result["file"], "shatter.json")
        self.assertEqual(result["data"]["word"], "shatter")
        self.assertEqual(result["redirect"]["status"], "redirected")

    def test_detail_lookup_ignores_stale_redirect_target(self):
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            with (
                patch.object(vocabulary, "VOCAB_DIR", str(root)),
                patch.object(review_vocabulary, "VOCAB_DIR", str(root)),
            ):
                save_redirect(
                    source_category="daily",
                    source_filename="ghosted.json",
                    source_word="ghosted",
                    target_category="daily",
                    target_filename="ghost.json",
                    target_word="ghost",
                    reason="rename_merge",
                )

                with self.assertRaises(Exception) as context:
                    get_vocab_detail("ghosted.json", "daily")

        self.assertEqual(getattr(context.exception, "status_code", None), 404)

    def test_detail_lookup_falls_back_to_merged_from_alias(self):
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            with (
                patch.object(vocabulary, "VOCAB_DIR", str(root)),
                patch.object(review_vocabulary, "VOCAB_DIR", str(root)),
            ):
                vocabulary.merge_or_create_vocab(
                    word="shatter",
                    context="",
                    source_name="",
                    category="daily",
                )
                saved = vocabulary.load_vocab("shatter", "daily")
                saved["mergedFrom"] = ["shatters"]
                vocabulary.save_vocab("shatter", saved, "daily")

                result = get_vocab_detail("shatters.json", "daily")

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["category"], "daily")
        self.assertEqual(result["file"], "shatter.json")
        self.assertEqual(result["data"]["word"], "shatter")
        self.assertEqual(result["redirect"]["source"], "mergedFrom")

    def test_review_suggest_follows_merge_redirect(self):
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            with (
                patch.object(vocabulary, "VOCAB_DIR", str(root)),
                patch.object(review_vocabulary, "VOCAB_DIR", str(root)),
            ):
                vocabulary.merge_or_create_vocab(
                    word="shatter",
                    context="",
                    source_name="",
                    category="daily",
                )
                save_redirect(
                    source_category="daily",
                    source_filename="shatters.json",
                    source_word="shatters",
                    target_category="daily",
                    target_filename="shatter.json",
                    target_word="shatter",
                    reason="rename_merge",
                )

                result = review_routes.review_suggest(
                    review_routes.ReviewSuggestRequest(
                        category="daily",
                        filename="shatters.json",
                        score=4,
                        review_date="2026-08-28",
                    )
                )

                saved = vocabulary.load_vocab("shatter", "daily")

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["category"], "daily")
        self.assertEqual(result["file"], "shatter.json")
        self.assertEqual(result["word"], "shatter")
        self.assertEqual(result["redirect"]["status"], "redirected")
        self.assertEqual(saved["reviews"], [{"date": "2026-08-28", "score": 4}])
        self.assertTrue(
            vocabulary_entry_needs_processing(
                {
                    "word": "blank",
                    "definitions": ["空格；留白"],
                    "examples": [
                        {
                            "text": "The answer option is ____.",
                            "explanation": "",
                        }
                    ],
                }
            )
        )


if __name__ == "__main__":
    unittest.main()

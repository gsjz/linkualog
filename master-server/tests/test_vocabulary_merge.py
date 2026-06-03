import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from core import vocabulary


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


if __name__ == "__main__":
    unittest.main()

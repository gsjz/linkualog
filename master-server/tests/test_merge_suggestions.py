import unittest
from services.analysis import analyze_file_cleaning_suggestions, analyze_folder_merge_suggestions
from services.lemma_dictionary import get_lemma_words
from services.review_llm import (
    _normalize_file_cleaning_result,
    _normalize_definition_suggestions,
    _normalize_example_suggestions,
    _select_folder_merge_words,
    get_dictionary_merge_target_candidates,
)


def vocab_entry(word: str) -> tuple[str, dict]:
    return (
        f"/tmp/{word}.json",
        {
            "word": word,
            "definitions": [],
            "reviews": [],
            "examples": [
                {
                    "text": f"Example context for {word}.",
                    "focusWords": [word],
                }
            ],
        },
    )


class MergeSuggestionTests(unittest.TestCase):
    def test_heuristic_create_target_uses_dictionary_lemmas(self):
        result = analyze_folder_merge_suggestions(
            [
                vocab_entry("irritating"),
                vocab_entry("breed"),
                vocab_entry("underprivileged"),
            ],
            include_low_confidence=True,
        )

        pairs = {
            (item["source"]["word"], item["target"]["word"])
            for item in result["suggestions"]
        }
        self.assertIn(("irritating", "irritate"), pairs)
        self.assertNotIn(("breed", "bree"), pairs)
        self.assertNotIn(("underprivileged", "underprivileg"), pairs)

    def test_heuristic_selects_highest_dictionary_candidate(self):
        result = analyze_folder_merge_suggestions(
            [
                vocab_entry("hoped"),
            ],
            include_low_confidence=True,
        )

        self.assertEqual(len(result["suggestions"]), 1)
        suggestion = result["suggestions"][0]
        self.assertEqual(suggestion["source"]["word"], "hoped")
        self.assertEqual(suggestion["target"]["word"], "hope")

    def test_llm_scoping_ignores_suffix_candidates_not_in_dictionary(self):
        words, _ = _select_folder_merge_words(
            [
                vocab_entry("irritating"),
                vocab_entry("breed"),
                vocab_entry("underprivileged"),
            ],
            word_limit=200,
        )

        self.assertIn("irritating", words)
        self.assertNotIn("breed", words)
        self.assertNotIn("underprivileged", words)

    def test_llm_candidate_guard_uses_dictionary_targets(self):
        self.assertEqual(get_dictionary_merge_target_candidates("breed"), [])
        self.assertEqual(get_dictionary_merge_target_candidates("underprivileged"), [])
        self.assertEqual(get_dictionary_merge_target_candidates("irritating"), ["irritate"])

    def test_dictionary_contains_expected_lemmas_only(self):
        lemmas = get_lemma_words()

        self.assertIn("breed", lemmas)
        self.assertIn("irritate", lemmas)
        self.assertIn("underprivileged", lemmas)
        self.assertNotIn("bree", lemmas)
        self.assertNotIn("underprivileg", lemmas)

    def test_file_cleaning_normalizes_entry_rename_and_split(self):
        normalized = _normalize_file_cleaning_result(
            {
                "entry": [
                    {
                        "action": "rename",
                        "suggested_word": "elaborate",
                        "confidence": 0.91,
                        "reason": "signs 是例句宾语",
                    },
                    {
                        "action": "split",
                        "confidence": 0.88,
                        "suggested_entries": [
                            {
                                "word": "an assortment of",
                                "definitions": ["各种各样的，一系列"],
                                "focus_words": ["an assortment of"],
                                "example_indices": [0],
                            },
                            {
                                "word": "ailment",
                                "definitions": ["疾病，小病"],
                                "focus_words": ["ailments"],
                                "example_indices": [0],
                            },
                        ],
                    },
                ]
            }
        )

        self.assertEqual(normalized["entry"][0]["action"], "rename")
        self.assertEqual(normalized["entry"][0]["suggested_word"], "elaborate")
        self.assertEqual(normalized["entry"][1]["action"], "split")
        self.assertEqual(
            [item["word"] for item in normalized["entry"][1]["suggested_entries"]],
            ["an assortment of", "ailment"],
        )

    def test_file_cleaning_flags_missing_definitions(self):
        result = analyze_file_cleaning_suggestions(
            "ailment.json",
            {
                "word": "ailment",
                "definitions": [],
                "examples": [
                    {
                        "text": "The clinic treats an assortment of ailments.",
                        "focusWords": ["ailments"],
                    }
                ],
            },
        )

        self.assertEqual(result["definition_count"], 0)
        self.assertIn(
            "definition_missing",
            {item["type"] for item in result["suggestions"]},
        )

    def test_file_cleaning_flags_missing_example_explanation(self):
        result = analyze_file_cleaning_suggestions(
            "ailment.json",
            {
                "word": "ailment",
                "definitions": ["疾病；小病"],
                "examples": [
                    {
                        "text": "The clinic treats an assortment of ailments.",
                        "focusWords": ["ailments"],
                        "explanation": "",
                    }
                ],
            },
        )

        missing_items = [
            item
            for item in result["suggestions"]
            if item["type"] == "example_missing_explanation"
        ]
        self.assertEqual(len(missing_items), 1)
        self.assertEqual(missing_items[0]["index"], 0)

    def test_missing_definition_llm_payload_normalizes_to_append(self):
        normalized = _normalize_definition_suggestions(
            [
                {
                    "action": "append",
                    "reason": "definitions 为空",
                    "suggested": "小病；不严重的疾病；身体不适",
                }
            ]
        )

        self.assertEqual(
            normalized,
            [
                {
                    "action": "append",
                    "reason": "definitions 为空",
                    "suggested": "小病；不严重的疾病；身体不适",
                }
            ],
        )

    def test_missing_example_explanation_payload_normalizes_to_rewrite(self):
        normalized = _normalize_example_suggestions(
            [
                {
                    "index": 0,
                    "action": "rewrite",
                    "reason": "explanation 为空",
                    "suggested_explanation": "这句话表示诊所治疗各种疾病，ailments 指小病或身体不适。",
                }
            ]
        )

        self.assertEqual(
            normalized,
            [
                {
                    "index": 0,
                    "action": "rewrite",
                    "reason": "explanation 为空",
                    "suggested_explanation": "这句话表示诊所治疗各种疾病，ailments 指小病或身体不适。",
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()

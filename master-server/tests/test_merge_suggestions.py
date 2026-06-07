import unittest
from unittest.mock import patch

from core.refine_cache import FILE_REFINE_PROMPT_VERSION, build_refine_cache_key
from services.analysis import analyze_file_cleaning_suggestions, analyze_folder_merge_suggestions
from services.lemma_dictionary import get_lemma_words
from services.review_llm import (
    _normalize_file_cleaning_result,
    _normalize_definition_suggestions,
    _normalize_example_suggestions,
    _select_folder_merge_words,
    get_dictionary_ambiguous_merge_target_candidates,
    get_dictionary_merge_target_candidates,
    suggest_entry_quality_with_rules,
    suggest_file_cleaning_with_llm,
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
        self.assertEqual(get_dictionary_merge_target_candidates("hinder"), [])
        self.assertEqual(get_dictionary_ambiguous_merge_target_candidates("hinder"), ["hind"])
        self.assertEqual(get_dictionary_merge_target_candidates("underprivileged"), [])
        self.assertEqual(get_dictionary_merge_target_candidates("irritating"), ["irritate"])
        self.assertEqual(get_dictionary_merge_target_candidates("pledged"), ["pledge"])
        self.assertEqual(get_dictionary_merge_target_candidates("larger"), ["large"])
        self.assertEqual(get_dictionary_merge_target_candidates("bigger"), ["big"])

    def test_dictionary_contains_expected_lemmas_only(self):
        lemmas = get_lemma_words()

        self.assertIn("breed", lemmas)
        self.assertIn("irritate", lemmas)
        self.assertIn("underprivileged", lemmas)
        self.assertNotIn("bree", lemmas)
        self.assertNotIn("underprivileg", lemmas)

    def test_file_cleaning_normalizes_entry_rename_and_ignores_split(self):
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
        self.assertEqual(len(normalized["entry"]), 1)

    def test_file_cleaning_normalizes_entry_merge_to_rename(self):
        normalized = _normalize_file_cleaning_result(
            {
                "entry": [
                    {
                        "action": "merge",
                        "suggested_word": "hope",
                        "confidence": 0.93,
                        "reason": "hoped 应归并到 hope",
                    },
                ]
            }
        )

        self.assertEqual(
            normalized["entry"],
            [
                {
                    "action": "rename",
                    "suggested_word": "hope",
                    "reason": "hoped 应归并到 hope",
                    "confidence": 0.93,
                }
            ],
        )

    def test_file_cleaning_rule_hints_pledged_should_merge_to_lemma(self):
        suggestions = suggest_entry_quality_with_rules(
            "pledged",
            ["已承诺的；保证的"],
            [
                {
                    "text": "The pledged funds were released.",
                    "focusWords": ["pledged"],
                }
            ],
        )

        self.assertEqual(len(suggestions), 1)
        self.assertEqual(suggestions[0]["action"], "rename")
        self.assertEqual(suggestions[0]["suggested_word"], "pledge")
        self.assertEqual(suggestions[0]["source"], "lemma_rule")

    def test_file_cleaning_rule_sends_hinder_candidate_to_llm_review(self):
        suggestions = suggest_entry_quality_with_rules(
            "hinder",
            ["阻碍；妨碍"],
            [
                {
                    "text": "Urban design can hinder or promote healthier choices.",
                    "focusWords": ["hinder"],
                }
            ],
        )

        self.assertEqual(len(suggestions), 1)
        self.assertEqual(suggestions[0]["type"], "lemma_candidate_review")
        self.assertEqual(suggestions[0]["source"], "lemma_review")
        self.assertEqual(suggestions[0]["suggested_action"], "llm_judge")
        self.assertEqual(suggestions[0]["suggested_word"], "hind")
        self.assertNotIn("action", suggestions[0])

    def test_file_cleaning_prompt_emphasizes_inflection_lemma_rename(self):
        captured_prompts = []

        def fake_call(prompt, **_kwargs):
            captured_prompts.append(prompt)
            return {"entry": [], "definitions": [], "examples": [], "global_notes": []}

        with patch("services.review_llm._call_llm_json", side_effect=fake_call):
            suggest_file_cleaning_with_llm(
                "pledged",
                ["已承诺的；保证的"],
                [{"text": "The pledged funds were released.", "focusWords": ["pledged"]}],
                rule_suggestions=[
                    {
                        "type": "entry_lemma_merge",
                        "action": "rename",
                        "suggested_word": "pledge",
                        "source": "lemma_rule",
                    }
                ],
            )

        self.assertEqual(len(captured_prompts), 1)
        prompt = captured_prompts[0]
        self.assertIn("屈折词形归并规则", prompt)
        self.assertIn("pledged -> pledge", prompt)
        self.assertIn("source=lemma_rule", prompt)
        self.assertIn('"suggested_word": "pledge"', prompt)

    def test_file_cleaning_prompt_marks_ambiguous_lemma_candidate_as_llm_review(self):
        captured_prompts = []

        def fake_call(prompt, **_kwargs):
            captured_prompts.append(prompt)
            return {"entry": [], "definitions": [], "examples": [], "global_notes": []}

        with patch("services.review_llm._call_llm_json", side_effect=fake_call):
            suggest_file_cleaning_with_llm(
                "hinder",
                ["阻碍；妨碍"],
                [{"text": "Urban design can hinder or promote healthier choices.", "focusWords": ["hinder"]}],
                rule_suggestions=[
                    {
                        "type": "lemma_candidate_review",
                        "suggested_action": "llm_judge",
                        "suggested_word": "hind",
                        "source": "lemma_review",
                    }
                ],
            )

        self.assertEqual(len(captured_prompts), 1)
        prompt = captured_prompts[0]
        self.assertIn("source=lemma_review", prompt)
        self.assertIn("lemma_candidate_review", prompt)
        self.assertIn("不能直接照抄为 entry.rename", prompt)
        self.assertIn('"suggested_word": "hind"', prompt)

    def test_file_refine_cache_key_tracks_prompt_version(self):
        cache_meta = build_refine_cache_key(
            "daily",
            "pledged.json",
            {
                "word": "pledged",
                "definitions": ["已承诺的；保证的"],
                "examples": [{"text": "The pledged funds were released.", "focusWords": ["pledged"]}],
            },
        )

        self.assertEqual(cache_meta["prompt_version"], FILE_REFINE_PROMPT_VERSION)

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
                    "confidence": 0.61,
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
                    "confidence": 0.61,
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
                    "confidence": 0.58,
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
                    "confidence": 0.58,
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from core import vocabulary
from services import llm


class FakeResponse:
    def __init__(self, content):
        self.content = content

    def raise_for_status(self):
        return None

    def json(self):
        return {
            "choices": [
                {
                    "message": {
                        "content": self.content,
                    },
                },
            ],
        }


class TaskNameRecommendationTests(unittest.TestCase):
    def test_list_vocab_source_names_dedupes_examples_by_text(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "ielts").mkdir()
            (root / "daily").mkdir()
            (root / "ielts" / "alpha.json").write_text(
                json.dumps(
                    {
                        "word": "alpha",
                        "examples": [
                            {"source": {"text": "剑桥 5 1 阅读3"}},
                            {"source": {"text": "  剑桥 5 1 阅读3  "}},
                            {"source": {"text": "TED Talk"}},
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (root / "daily" / "beta.json").write_text(
                json.dumps(
                    {
                        "word": "beta",
                        "examples": [
                            {"source": {"text": "ted talk"}},
                            {"source": "Daily Reading"},
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            with patch.object(vocabulary, "VOCAB_DIR", str(root)):
                names = vocabulary.list_vocab_source_names()

            self.assertEqual(len(names), 3)
            self.assertIn("剑桥 5 1 阅读3", names)
            self.assertIn("Daily Reading", names)
            self.assertEqual(sum(1 for name in names if name.casefold() == "ted talk"), 1)

    def test_recommend_task_name_returns_clean_json_name(self):
        captured_payloads = []

        def fake_post(url, headers, json, timeout):
            captured_payloads.append(json)
            return FakeResponse('```json\n{"name":"剑桥 5 1 阅读3","reason":"匹配已有来源"}\n```')

        with (
            patch.object(
                llm,
                "get_config_data",
                return_value={
                    "api_key": "test-key",
                    "provider": "https://provider.example/v1",
                    "model": "text-model",
                },
            ),
            patch.object(llm.requests, "post", side_effect=fake_post),
        ):
            result = llm.recommend_task_name("剑桥阅读3", ["剑桥 5 1 阅读3", "剑桥 5 1 阅读3"])

        self.assertEqual(result["name"], "剑桥 5 1 阅读3")
        self.assertEqual(result["reason"], "匹配已有来源")
        self.assertEqual(result["source_count"], 1)
        self.assertIn("剑桥 5 1 阅读3", captured_payloads[0]["messages"][1]["content"])

    def test_cet_reading_context_guides_llm_instead_of_rule_return(self):
        context = (
            "49. What is worth bearing in mind concerning social media platforms?\n"
            "50. What does the author think is really important for those living in digital exclusion?\n"
            "Passage Two\n"
            "Questions 51 to 55 are based on the following passage.\n"
            "51. What does the author think is easy to see in many areas of contemporary life?"
        )
        captured_payloads = []

        def fake_post(url, headers, json, timeout):
            captured_payloads.append(json)
            return FakeResponse('{"name":"CET6 23 12 2 阅读2","reason":"根据 Passage Two 和 51-55 判断为阅读第二篇"}')

        with (
            patch.object(
                llm,
                "get_config_data",
                return_value={
                    "api_key": "test-key",
                    "provider": "https://provider.example/v1",
                    "model": "text-model",
                },
            ),
            patch.object(llm.requests, "post", side_effect=fake_post),
        ):
            result = llm.recommend_task_name(
                "CET6 23 12 2",
                ["CET6 23 12 2 匹配", "CET 23 12 2 阅读1", "CET6 23 12 1 听力"],
                context,
            )

        self.assertEqual(result["name"], "CET6 23 12 2 阅读2")
        self.assertEqual(result["source"], "llm")
        self.assertIn("阅读", result["reason"])
        self.assertNotIn("匹配", result["name"])
        self.assertEqual(len(captured_payloads), 1)
        prompt = captured_payloads[0]["messages"][1]["content"]
        self.assertIn("边角处", prompt)
        self.assertIn("Passage Two", prompt)
        self.assertIn("Questions 51 to 55", prompt)
        self.assertIn("CET 23 12 2 阅读1", prompt)

    def test_blank_subject_uses_context_and_source_examples_in_llm_prompt(self):
        context = (
            "Passage Two\n"
            "Questions 51 to 55 are based on the following passage.\n"
            "51. What does the author think is easy to see in many areas of contemporary life?"
        )
        captured_payloads = []

        def fake_post(url, headers, json, timeout):
            captured_payloads.append(json)
            return FakeResponse('{"name":"CET6 23 12 2 阅读2","reason":"主体未填写，根据 Passage Two、51-55 和已有 CET 阅读命名样例推断"}')

        with (
            patch.object(
                llm,
                "get_config_data",
                return_value={
                    "api_key": "test-key",
                    "provider": "https://provider.example/v1",
                    "model": "text-model",
                },
            ),
            patch.object(llm.requests, "post", side_effect=fake_post),
        ):
            result = llm.recommend_task_name(
                "",
                ["CET6 23 12 2 匹配", "CET 23 12 2 阅读1", "剑桥 5 3 阅读2"],
                context,
            )

        self.assertEqual(result["name"], "CET6 23 12 2 阅读2")
        self.assertEqual(result["source"], "llm")
        self.assertEqual(len(captured_payloads), 1)
        prompt = captured_payloads[0]["messages"][1]["content"]
        self.assertIn("任务主体线索: 未填写", prompt)
        self.assertIn("主体线索未填写", prompt)
        self.assertIn("优先使用 CET6", prompt)
        self.assertIn("Passage Two", prompt)
        self.assertIn("Questions 51 to 55", prompt)
        self.assertIn("CET6 23 12 2 匹配", prompt)
        self.assertIn("CET 23 12 2 阅读1", prompt)
        self.assertIn("阅读2", prompt)
        self.assertIn('"prefer_cet6_when_cet6_evidence_exists": true', prompt)


if __name__ == "__main__":
    unittest.main()

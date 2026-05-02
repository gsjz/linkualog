import io
import unittest
from datetime import date, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi import BackgroundTasks
from starlette.datastructures import UploadFile

from api import review_routes, routes
from core import config, review_vocabulary, storage, tasks, vocabulary


class QQConnectorContractTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        super().setUp()
        self.tempdir = TemporaryDirectory()
        self.base_dir = Path(self.tempdir.name)
        self.storage_dir = self.base_dir / "temp_storage"
        self.vocab_dir = self.base_dir / "data"
        self.tasks_file = self.base_dir / "local_data_runtime" / "tasks_db.json"
        self.lock_file = self.tasks_file.with_suffix(".json.lock")

        self.original_storage_dir = storage.STORAGE_DIR
        self.original_vocab_dir = vocabulary.VOCAB_DIR
        self.original_review_vocab_dir = review_vocabulary.VOCAB_DIR
        self.original_tasks_file = tasks.TASKS_FILE
        self.original_lock_file = tasks.LOCK_FILE
        self.original_config_file = config.CONFIG_FILE

        storage.STORAGE_DIR = str(self.storage_dir)
        vocabulary.VOCAB_DIR = str(self.vocab_dir)
        review_vocabulary.VOCAB_DIR = str(self.vocab_dir)
        tasks.TASKS_FILE = str(self.tasks_file)
        tasks.LOCK_FILE = str(self.lock_file)
        config.CONFIG_FILE = self.base_dir / "local_data_runtime" / "llm_config.json"

        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.vocab_dir.mkdir(parents=True, exist_ok=True)
        self.tasks_file.parent.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        storage.STORAGE_DIR = self.original_storage_dir
        vocabulary.VOCAB_DIR = self.original_vocab_dir
        review_vocabulary.VOCAB_DIR = self.original_review_vocab_dir
        tasks.TASKS_FILE = self.original_tasks_file
        tasks.LOCK_FILE = self.original_lock_file
        config.CONFIG_FILE = self.original_config_file
        self.tempdir.cleanup()
        super().tearDown()

    def test_add_vocabulary_matches_qq_connector_payload_shape(self):
        first = routes.VocabAddRequest(
            word="qqe2e-session",
            context="This connector test should write into linkualog.",
            source="qq connector live e2e",
            fetch_llm=False,
            fetch_type="all",
            category="daily",
            focus_positions=[],
            llm_result={},
            youtube={},
        )
        second = routes.VocabAddRequest(
            word="qqe2e-session",
            context="A second example should merge into the same vocab file.",
            source="qq add mode",
            fetch_llm=False,
            fetch_type="all",
            category="daily",
            focus_positions=[],
            llm_result={},
            youtube={},
        )

        first_result = routes.add_vocabulary(first)
        second_result = routes.add_vocabulary(second)

        self.assertEqual(first_result["status"], "success")
        self.assertEqual(second_result["status"], "success")

        data = second_result["data"]
        self.assertEqual(data["word"], "qqe2e-session")
        self.assertEqual(data["definitions"], [])
        self.assertEqual(len(data["examples"]), 2)
        self.assertEqual(data["examples"][0]["source"]["text"], "qq connector live e2e")
        self.assertEqual(data["examples"][1]["source"]["text"], "qq add mode")

        vocab_path = Path(vocabulary.get_vocab_path("qqe2e-session", "daily", create_dir=False))
        self.assertTrue(vocab_path.exists())
        loaded = vocabulary.load_vocab("qqe2e-session", "daily")
        self.assertEqual(len(loaded["examples"]), 2)

    async def test_upload_resource_supports_collected_mode_for_qq_upload(self):
        background_tasks = BackgroundTasks()
        upload = UploadFile(filename="qq-connector-sample.png", file=io.BytesIO(b"fake-image-bytes"))

        result = await routes.upload_resource(
            background_tasks=background_tasks,
            files=[upload],
            taskName="QQ 收集 2026-04-19",
            startPage=1,
            autoProcess=False,
        )

        self.assertEqual(result["status"], "success")
        self.assertFalse(result["auto_process"])
        self.assertEqual(result["total"], 1)
        self.assertEqual(len(background_tasks.tasks), 0)

        task_id = result["task_id"]
        saved = tasks.load_tasks()[task_id]
        self.assertEqual(saved["status"], "collected")
        self.assertFalse(saved["auto_process"])
        self.assertEqual(saved["total"], 1)

        saved_path = Path(saved["sub_tasks"][0]["path"])
        self.assertTrue(saved_path.exists())

        task_payload = routes.get_task_status(task_id)
        self.assertEqual(task_payload["status"], "collected")

        delete_result = routes.delete_task(task_id)
        self.assertEqual(delete_result["status"], "success")
        self.assertFalse(saved_path.exists())
        self.assertNotIn(task_id, tasks.load_tasks())

    def test_rename_vocabulary_updates_filename_and_word_references(self):
        source_path = self.vocab_dir / "daily" / "tam.json"
        source_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.write_text(
            """{
  "word": "tam",
  "createdAt": "2026-04-20",
  "reviews": [],
  "definitions": ["vt. 驯服"],
  "examples": [
    {
      "text": "They tamed fire.",
      "explanation": "",
      "focusWords": ["tam"]
    }
  ],
  "reviewSessions": [
    {
      "word": "tam",
      "score": 0
    }
  ]
}
""",
            encoding="utf-8",
        )

        result = review_routes.rename_vocab(
            review_routes.VocabRenameRequest(
                category="daily",
                filename="tam.json",
                word="tame",
                data={
                    "word": "tam",
                    "createdAt": "2026-04-20",
                    "reviews": [],
                    "definitions": ["vt. 驯服"],
                    "examples": [
                        {
                            "text": "They prayed to the stars, tamed fire, and turned stones into tools.",
                            "explanation": "这里表示人类驯服并掌控了火。",
                            "focusWords": ["tam"],
                        }
                    ],
                    "reviewSessions": [
                        {
                            "word": "tam",
                            "score": 0,
                        }
                    ],
                },
            )
        )

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["file"], "tame.json")
        self.assertFalse(source_path.exists())

        target_path = self.vocab_dir / "daily" / "tame.json"
        self.assertTrue(target_path.exists())
        renamed = review_vocabulary.load_vocab_file(str(target_path))
        self.assertEqual(renamed["word"], "tame")
        self.assertEqual(renamed["examples"][0]["focusWords"], ["tame"])
        self.assertEqual(renamed["reviewSessions"][0]["word"], "tame")
        self.assertEqual(
            renamed["examples"][0]["explanation"],
            "这里表示人类驯服并掌控了火。",
        )

    def test_rename_vocabulary_merges_when_target_exists(self):
        category_dir = self.vocab_dir / "daily"
        category_dir.mkdir(parents=True, exist_ok=True)
        source_path = category_dir / "erod.json"
        target_path = category_dir / "erode.json"
        source_path.write_text(
            """{
  "word": "erod",
  "createdAt": "2026-04-20",
  "reviews": [{"date": "2026-04-21", "score": 2}],
  "definitions": ["错误切分，应为 erode"],
  "examples": [
    {
      "text": "The coastline was eroded by waves.",
      "explanation": "海岸线被海浪侵蚀。",
      "focusWords": ["erod"]
    }
  ]
}
""",
            encoding="utf-8",
        )
        target_path.write_text(
            """{
  "word": "erode",
  "createdAt": "2026-04-19",
  "reviews": [{"date": "2026-04-20", "score": 4}],
  "definitions": ["侵蚀；腐蚀"],
  "examples": [
    {
      "text": "Acid can erode metal.",
      "explanation": "酸会腐蚀金属。",
      "focusWords": ["erode"]
    }
  ]
}
""",
            encoding="utf-8",
        )

        result = review_routes.rename_vocab(
            review_routes.VocabRenameRequest(
                category="daily",
                filename="erod.json",
                word="erode",
                data={
                    "word": "erod",
                    "createdAt": "2026-04-20",
                    "reviews": [{"date": "2026-04-21", "score": 2}],
                    "definitions": ["错误切分，应为 erode"],
                    "examples": [
                        {
                            "text": "The coastline was eroded by waves.",
                            "explanation": "海岸线被海浪侵蚀。",
                            "focusWords": ["erod"],
                        }
                    ],
                },
            )
        )

        self.assertEqual(result["status"], "success")
        self.assertTrue(result["merged_to_existing"])
        self.assertFalse(source_path.exists())
        self.assertTrue(target_path.exists())

        merged = review_vocabulary.load_vocab_file(str(target_path))
        self.assertEqual(merged["word"], "erode")
        self.assertIn("侵蚀；腐蚀", merged["definitions"])
        self.assertIn("错误切分，应为 erode", merged["definitions"])
        self.assertEqual(len(merged["examples"]), 2)
        self.assertIn("erod", merged["mergedFrom"])
        self.assertIn({"date": "2026-04-20", "score": 4}, merged["reviews"])
        self.assertIn({"date": "2026-04-21", "score": 2}, merged["reviews"])

    def test_apply_merge_merges_into_existing_target(self):
        category_dir = self.vocab_dir / "daily"
        category_dir.mkdir(parents=True, exist_ok=True)
        source_path = category_dir / "irritating.json"
        target_path = category_dir / "irritate.json"
        source_path.write_text(
            """{
  "word": "irritating",
  "createdAt": "2026-04-20",
  "reviews": [],
  "definitions": ["令人恼火的"],
  "examples": [
    {
      "text": "The noise is irritating.",
      "explanation": "噪音令人烦躁。",
      "focusWords": ["irritating"]
    }
  ]
}
""",
            encoding="utf-8",
        )
        target_path.write_text(
            """{
  "word": "irritate",
  "createdAt": "2026-04-19",
  "reviews": [],
  "definitions": ["使恼怒；刺激"],
  "examples": [
    {
      "text": "Smoke can irritate your eyes.",
      "explanation": "烟会刺激眼睛。",
      "focusWords": ["irritate"]
    }
  ]
}
""",
            encoding="utf-8",
        )

        result = review_routes.apply_merge(
            review_routes.MergeApplyRequest(
                category="daily",
                source_filename="irritating.json",
                target_filename="irritate.json",
                delete_source=True,
                create_target_if_missing=False,
            )
        )

        self.assertEqual(result["status"], "success")
        self.assertFalse(source_path.exists())
        merged = review_vocabulary.load_vocab_file(str(target_path))
        self.assertEqual(merged["word"], "irritate")
        self.assertIn("使恼怒；刺激", merged["definitions"])
        self.assertIn("令人恼火的", merged["definitions"])
        self.assertEqual(len(merged["examples"]), 2)
        self.assertIn("irritating", merged["mergedFrom"])

    def test_apply_split_creates_target_entries_and_removes_source(self):
        source_path = self.vocab_dir / "cet" / "assortment-of-ailments.json"
        source_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.write_text(
            """{
  "word": "assortment of ailments",
  "createdAt": "2026-04-21",
  "reviews": [],
  "definitions": ["各种疾病"],
  "examples": [
    {
      "text": "The clinic treats an assortment of ailments.",
      "explanation": "诊所治疗各种各样的小病。",
      "focusWords": ["assortment of ailments"]
    }
  ]
}
""",
            encoding="utf-8",
        )

        result = review_routes.apply_split(
            review_routes.SplitApplyRequest(
                category="cet",
                source_filename="assortment-of-ailments.json",
                delete_source=True,
                suggestion={
                    "action": "split",
                    "reason": "拆成搭配和核心名词",
                    "suggested_entries": [
                        {
                            "word": "an assortment of",
                            "definitions": ["各种各样的；一系列"],
                            "focus_words": ["an assortment of"],
                            "example_indices": [0],
                        },
                        {
                            "word": "ailment",
                            "definitions": ["小病；病症"],
                            "focus_words": ["ailments"],
                            "example_indices": [0],
                        },
                    ],
                },
            )
        )

        self.assertEqual(result["status"], "success")
        self.assertTrue(result["source_deleted"])
        self.assertFalse(source_path.exists())

        assortment_path = self.vocab_dir / "cet" / "an-assortment-of.json"
        ailment_path = self.vocab_dir / "cet" / "ailment.json"
        self.assertTrue(assortment_path.exists())
        self.assertTrue(ailment_path.exists())

        assortment = review_vocabulary.load_vocab_file(str(assortment_path))
        ailment = review_vocabulary.load_vocab_file(str(ailment_path))
        self.assertEqual(assortment["word"], "an assortment of")
        self.assertEqual(assortment["examples"][0]["focusWords"], ["an assortment of"])
        self.assertEqual(ailment["word"], "ailment")
        self.assertEqual(ailment["examples"][0]["focusWords"], ["ailments"])
        self.assertEqual(ailment["splitFrom"][0]["file"], "assortment-of-ailments.json")

    def test_apply_split_merges_into_existing_target_entries(self):
        category_dir = self.vocab_dir / "cet"
        category_dir.mkdir(parents=True, exist_ok=True)
        source_path = category_dir / "assortment-of-ailments.json"
        ailment_path = category_dir / "ailment.json"
        source_path.write_text(
            """{
  "word": "assortment of ailments",
  "createdAt": "2026-04-21",
  "reviews": [],
  "definitions": ["各种疾病"],
  "examples": [
    {
      "text": "The clinic treats an assortment of ailments.",
      "explanation": "诊所治疗各种各样的小病。",
      "focusWords": ["assortment of ailments"]
    }
  ]
}
""",
            encoding="utf-8",
        )
        ailment_path.write_text(
            """{
  "word": "ailment",
  "createdAt": "2026-04-18",
  "reviews": [],
  "definitions": ["小病；病症"],
  "examples": [
    {
      "text": "The treatment is used for minor ailments.",
      "explanation": "这种治疗用于小病。",
      "focusWords": ["ailment"]
    }
  ]
}
""",
            encoding="utf-8",
        )

        result = review_routes.apply_split(
            review_routes.SplitApplyRequest(
                category="cet",
                source_filename="assortment-of-ailments.json",
                delete_source=True,
                suggestion={
                    "action": "split",
                    "reason": "拆出已有 ailment 词条",
                    "suggested_entries": [
                        {
                            "word": "ailment",
                            "definitions": ["小病；病症"],
                            "focus_words": ["ailments"],
                            "example_indices": [0],
                        }
                    ],
                },
            )
        )

        self.assertEqual(result["status"], "success")
        self.assertTrue(result["source_deleted"])
        self.assertFalse(source_path.exists())
        self.assertEqual(result["created_files"], [])
        self.assertEqual(result["updated_files"][0]["file"], "ailment.json")

        merged = review_vocabulary.load_vocab_file(str(ailment_path))
        self.assertEqual(merged["word"], "ailment")
        self.assertEqual(len(merged["examples"]), 2)
        self.assertEqual(merged["splitFrom"][0]["file"], "assortment-of-ailments.json")

    def test_review_recommend_respects_frontend_tuning_preferences(self):
        category_dir = self.vocab_dir / "daily"
        category_dir.mkdir(parents=True, exist_ok=True)
        today = date.today()

        entries = {
            "recent-low.json": {
                "word": "recent-low",
                "createdAt": (today - timedelta(days=1)).isoformat(),
                "reviews": [{"date": (today - timedelta(days=1)).isoformat(), "score": 1}],
                "definitions": [],
                "examples": [],
            },
            "old-high.json": {
                "word": "old-high",
                "createdAt": (today - timedelta(days=100)).isoformat(),
                "reviews": [{"date": (today - timedelta(days=1)).isoformat(), "score": 5}],
                "definitions": [],
                "examples": [],
            },
            "middle-unreviewed.json": {
                "word": "middle-unreviewed",
                "createdAt": (today - timedelta(days=45)).isoformat(),
                "reviews": [],
                "definitions": [],
                "examples": [],
            },
        }
        for filename, payload in entries.items():
            review_vocabulary.save_vocab_file(str(category_dir / filename), payload)

        recent_result = review_routes.review_recommend(
            review_routes.ReviewRecommendRequest(
                category="daily",
                limit=3,
                due_weight=0,
                created_weight=5,
                score_weight=0,
                created_order="recent",
                score_order="low",
            )
        )
        self.assertEqual(recent_result["recommended"]["word"], "recent-low")

        oldest_result = review_routes.review_recommend(
            review_routes.ReviewRecommendRequest(
                category="daily",
                limit=3,
                due_weight=0,
                created_weight=5,
                score_weight=0,
                created_order="oldest",
                score_order="low",
            )
        )
        self.assertEqual(oldest_result["recommended"]["word"], "old-high")

        low_score_result = review_routes.review_recommend(
            review_routes.ReviewRecommendRequest(
                category="daily",
                limit=3,
                due_weight=0,
                created_weight=0,
                score_weight=5,
                created_order="recent",
                score_order="low",
            )
        )
        self.assertEqual(low_score_result["recommended"]["word"], "middle-unreviewed")
        self.assertEqual(low_score_result["recommended"]["score_breakdown"]["last_score"], None)
        self.assertEqual(low_score_result["meta"]["preferences"]["score_order"], "low")

        high_score_result = review_routes.review_recommend(
            review_routes.ReviewRecommendRequest(
                category="daily",
                limit=3,
                due_weight=0,
                created_weight=0,
                score_weight=5,
                created_order="recent",
                score_order="high",
            )
        )
        self.assertEqual(high_score_result["recommended"]["word"], "old-high")
        self.assertEqual(high_score_result["recommended"]["score_breakdown"]["last_score"], 5)

    def test_review_recommend_uses_saved_server_preferences_by_default(self):
        category_dir = self.vocab_dir / "daily"
        category_dir.mkdir(parents=True, exist_ok=True)
        today = date.today()

        review_vocabulary.save_vocab_file(
            str(category_dir / "recent.json"),
            {
                "word": "recent",
                "createdAt": (today - timedelta(days=1)).isoformat(),
                "reviews": [],
                "definitions": [],
                "examples": [],
            },
        )
        review_vocabulary.save_vocab_file(
            str(category_dir / "oldest.json"),
            {
                "word": "oldest",
                "createdAt": (today - timedelta(days=100)).isoformat(),
                "reviews": [],
                "definitions": [],
                "examples": [],
            },
        )

        config.save_config_data(
            {
                "review_recommend_due_weight": 0,
                "review_recommend_created_weight": 5,
                "review_recommend_score_weight": 0,
                "review_recommend_created_order": "oldest",
                "review_recommend_score_order": "low",
            }
        )

        result = review_routes.review_recommend(
            review_routes.ReviewRecommendRequest(
                category="daily",
                limit=2,
            )
        )

        self.assertEqual(result["recommended"]["word"], "oldest")
        self.assertEqual(result["meta"]["preferences"]["created_order"], "oldest")
        self.assertEqual(result["meta"]["preferences"]["created_weight"], 5)


if __name__ == "__main__":
    unittest.main()

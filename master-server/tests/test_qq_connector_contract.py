import io
import unittest
from datetime import date, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi import BackgroundTasks
from starlette.datastructures import UploadFile

from api import review_routes, routes
from core import config, refine_cache, review_vocabulary, storage, tasks, vocabulary


class QQConnectorContractTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        super().setUp()
        self.tempdir = TemporaryDirectory()
        self.base_dir = Path(self.tempdir.name)
        self.storage_dir = self.base_dir / "temp_storage"
        self.vocab_dir = self.base_dir / "data"
        self.tasks_file = self.base_dir / "local_data_runtime" / "tasks_db.json"
        self.lock_file = self.tasks_file.with_suffix(".json.lock")
        self.refine_cache_dir = self.base_dir / "local_data_runtime" / "refine_cache"

        self.original_storage_dir = storage.STORAGE_DIR
        self.original_vocab_dir = vocabulary.VOCAB_DIR
        self.original_review_vocab_dir = review_vocabulary.VOCAB_DIR
        self.original_tasks_file = tasks.TASKS_FILE
        self.original_lock_file = tasks.LOCK_FILE
        self.original_config_file = config.CONFIG_FILE
        self.original_refine_cache_dir = refine_cache.REFINE_CACHE_DIR

        storage.STORAGE_DIR = str(self.storage_dir)
        vocabulary.VOCAB_DIR = str(self.vocab_dir)
        review_vocabulary.VOCAB_DIR = str(self.vocab_dir)
        tasks.TASKS_FILE = str(self.tasks_file)
        tasks.LOCK_FILE = str(self.lock_file)
        config.CONFIG_FILE = self.base_dir / "local_data_runtime" / "llm_config.json"
        refine_cache.REFINE_CACHE_DIR = self.refine_cache_dir

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
        refine_cache.REFINE_CACHE_DIR = self.original_refine_cache_dir
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

    def test_list_vocabulary_marks_entries_needing_processing(self):
        category_dir = self.vocab_dir / "daily"
        category_dir.mkdir(parents=True, exist_ok=True)

        review_vocabulary.save_vocab_file(
            str(category_dir / "complete.json"),
            {
                "word": "complete",
                "createdAt": "2026-05-01",
                "reviews": [],
                "definitions": ["完整的；完成的"],
                "examples": [
                    {
                        "text": "This entry is complete.",
                        "explanation": "这里表示词条内容完整。",
                    }
                ],
            },
        )
        review_vocabulary.save_vocab_file(
            str(category_dir / "missing-definition.json"),
            {
                "word": "missing-definition",
                "createdAt": "2026-05-02",
                "reviews": [],
                "definitions": [],
                "examples": [
                    {
                        "text": "This entry has no definition.",
                        "explanation": "这里缺少释义。",
                    }
                ],
            },
        )
        review_vocabulary.save_vocab_file(
            str(category_dir / "missing-explanation.json"),
            {
                "word": "missing-explanation",
                "createdAt": "2026-05-03",
                "reviews": [],
                "definitions": ["缺少解释"],
                "examples": [
                    {
                        "text": "This example has no explanation.",
                        "explanation": "",
                    }
                ],
            },
        )
        review_vocabulary.save_vocab_file(
            str(category_dir / "intentional-blank.json"),
            {
                "word": "intentional-blank",
                "createdAt": "2026-05-04",
                "reviews": [],
                "definitions": ["故意留空"],
                "examples": [
                    {
                        "text": "The answer option is ____.",
                        "explanation": "",
                        "intentionalBlank": True,
                    }
                ],
            },
        )

        result = routes.list_vocabulary("daily")
        by_word = {item["word"]: item for item in result["entries"]}

        self.assertFalse(by_word["complete"]["needsProcessing"])
        self.assertTrue(by_word["missing-definition"]["needsProcessing"])
        self.assertTrue(by_word["missing-explanation"]["needsProcessing"])
        self.assertFalse(by_word["intentional-blank"]["needsProcessing"])

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

    def test_save_vocabulary_preserves_focus_positions_after_cjk_note(self):
        source_path = self.vocab_dir / "cet" / "keep-sth-at-bay.json"
        source_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.write_text(
            """{
  "word": "keep-sth-at-bay",
  "createdAt": "2026-04-27",
  "reviews": [],
  "definitions": ["使……无法靠近；遏制住"],
  "examples": []
}
""",
            encoding="utf-8",
        )

        example_text = (
            "Ms Gomez’s multi-millionaire status has allowed her to take the “social” out of "
            "social media, so she can continue to leverage her enormous fame while keeping "
            "the trolls (恶意挑衅的帖子) at bay."
        )

        result = review_routes.save_vocab(
            review_routes.VocabSaveRequest(
                category="cet",
                filename="keep-sth-at-bay.json",
                data={
                    "word": "keep-sth-at-bay",
                    "createdAt": "2026-04-27",
                    "reviews": [],
                    "definitions": ["使……无法靠近；遏制住"],
                    "examples": [
                        {
                            "text": example_text,
                            "explanation": "这里表示把干扰挡在外面。",
                            "focusWords": ["keep sth at bay"],
                            "focusPositions": [38, 39],
                        }
                    ],
                },
            )
        )

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["examples"][0]["focusPositions"], [38, 39])
        saved = review_vocabulary.load_vocab_file(str(source_path))
        self.assertEqual(saved["examples"][0]["focusPositions"], [38, 39])

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

    def test_manual_merge_can_merge_into_existing_entry_across_categories(self):
        source_path = self.vocab_dir / "daily" / "irritating.json"
        target_path = self.vocab_dir / "cet" / "irritate.json"
        source_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.write_text(
            """{
  "word": "irritating",
  "createdAt": "2026-04-20",
  "reviews": [{"date": "2026-04-21", "score": 1}],
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
  "examples": []
}
""",
            encoding="utf-8",
        )

        result = review_routes.manual_merge_vocab(
            review_routes.ManualVocabMergeRequest(
                source_category="daily",
                source_filename="irritating.json",
                target_category="cet",
                target_word="irritate",
                delete_source=True,
                create_target_if_missing=True,
            )
        )

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["target_category"], "cet")
        self.assertEqual(result["target_file"], "irritate.json")
        self.assertFalse(result["target_created"])
        self.assertTrue(result["source_deleted"])
        self.assertFalse(source_path.exists())
        merged = review_vocabulary.load_vocab_file(str(target_path))
        self.assertEqual(merged["word"], "irritate")
        self.assertIn("令人恼火的", merged["definitions"])
        self.assertEqual(len(merged["examples"]), 1)
        self.assertIn("irritating", merged["mergedFrom"])

    def test_manual_merge_can_create_target_word_without_creating_category(self):
        source_path = self.vocab_dir / "daily" / "hoped.json"
        target_path = self.vocab_dir / "daily" / "hope.json"
        source_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.write_text(
            """{
  "word": "hoped",
  "createdAt": "2026-04-20",
  "reviews": [],
  "definitions": ["hope 的过去式"],
  "examples": [
    {
      "text": "They hoped for rain.",
      "explanation": "他们希望下雨。",
      "focusWords": ["hoped"]
    }
  ]
}
""",
            encoding="utf-8",
        )

        result = review_routes.manual_merge_vocab(
            review_routes.ManualVocabMergeRequest(
                source_category="daily",
                source_filename="hoped.json",
                target_category="daily",
                target_word="hope",
                delete_source=True,
                create_target_if_missing=True,
            )
        )

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["target_file"], "hope.json")
        self.assertTrue(result["target_created"])
        self.assertTrue(result["source_deleted"])
        self.assertFalse(source_path.exists())
        self.assertTrue(target_path.exists())
        merged = review_vocabulary.load_vocab_file(str(target_path))
        self.assertEqual(merged["word"], "hope")
        self.assertIn("hope 的过去式", merged["definitions"])
        self.assertIn("hoped", merged["mergedFrom"])

    def test_manual_merge_does_not_create_target_category(self):
        source_path = self.vocab_dir / "daily" / "hoped.json"
        source_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.write_text(
            """{
  "word": "hoped",
  "createdAt": "2026-04-20",
  "reviews": [],
  "definitions": ["hope 的过去式"],
  "examples": []
}
""",
            encoding="utf-8",
        )

        with self.assertRaisesRegex(Exception, "404"):
            review_routes.manual_merge_vocab(
                review_routes.ManualVocabMergeRequest(
                    source_category="daily",
                    source_filename="hoped.json",
                    target_category="missing",
                    target_word="hope",
                    delete_source=True,
                    create_target_if_missing=True,
                )
            )

        self.assertTrue(source_path.exists())
        self.assertFalse((self.vocab_dir / "missing").exists())

    def test_apply_split_endpoint_is_removed(self):
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

        with self.assertRaises(Exception) as ctx:
            review_routes.apply_split(
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

        self.assertEqual(getattr(ctx.exception, "status_code", None), 410)
        self.assertTrue(source_path.exists())
        self.assertFalse((self.vocab_dir / "cet" / "an-assortment-of.json").exists())
        self.assertFalse((self.vocab_dir / "cet" / "ailment.json").exists())

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

        with self.assertRaises(Exception) as ctx:
            review_routes.apply_split(
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

        self.assertEqual(getattr(ctx.exception, "status_code", None), 410)
        self.assertTrue(source_path.exists())
        merged = review_vocabulary.load_vocab_file(str(ailment_path))
        self.assertEqual(merged["word"], "ailment")
        self.assertEqual(len(merged["examples"]), 1)
        self.assertNotIn("splitFrom", merged)

    def test_review_visualization_includes_recently_added_entries(self):
        category_dir = self.vocab_dir / "daily"
        category_dir.mkdir(parents=True, exist_ok=True)
        today = date.today()

        entries = {
            "newest.json": {
                "word": "newest",
                "createdAt": today.isoformat(),
                "reviews": [],
                "definitions": [],
                "examples": [],
            },
            "older.json": {
                "word": "older",
                "createdAt": (today - timedelta(days=12)).isoformat(),
                "reviews": [],
                "definitions": [],
                "examples": [],
            },
            "undated.json": {
                "word": "undated",
                "reviews": [],
                "definitions": [],
                "examples": [],
            },
        }
        for filename, payload in entries.items():
            review_vocabulary.save_vocab_file(str(category_dir / filename), payload)

        result = review_routes.review_visualization(category="daily")
        selected_words = [item["word"] for item in result["selected"]["recently_added"]]
        category_words = [item["word"] for item in result["category_summaries"]["daily"]["recently_added"]]

        self.assertEqual(selected_words, ["newest", "older"])
        self.assertEqual(category_words, ["newest", "older"])
        self.assertEqual(result["selected"]["recently_added"][0]["created_at"], today.isoformat())

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

    def test_review_recommend_filters_marked_entries_before_ranking(self):
        category_dir = self.vocab_dir / "daily"
        category_dir.mkdir(parents=True, exist_ok=True)
        today = date.today()

        review_vocabulary.save_vocab_file(
            str(category_dir / "marked-only.json"),
            {
                "word": "marked-only",
                "marked": True,
                "createdAt": today.isoformat(),
                "reviews": [],
                "definitions": [],
                "examples": [],
            },
        )
        review_vocabulary.save_vocab_file(
            str(category_dir / "unmarked-only.json"),
            {
                "word": "unmarked-only",
                "marked": False,
                "createdAt": today.isoformat(),
                "reviews": [],
                "definitions": [],
                "examples": [],
            },
        )

        marked_result = review_routes.review_recommend(
            review_routes.ReviewRecommendRequest(
                category="daily",
                limit=5,
                mark_filter="marked",
            )
        )
        self.assertEqual(marked_result["recommended"]["word"], "marked-only")
        self.assertTrue(marked_result["recommended"]["marked"])
        self.assertEqual(marked_result["meta"]["candidate_count"], 1)
        self.assertEqual(marked_result["meta"]["mark_filter"], "marked")

        unmarked_result = review_routes.review_recommend(
            review_routes.ReviewRecommendRequest(
                category="daily",
                limit=5,
                mark_filter="unmarked",
            )
        )
        self.assertEqual(unmarked_result["recommended"]["word"], "unmarked-only")
        self.assertFalse(unmarked_result["recommended"]["marked"])
        self.assertEqual(unmarked_result["meta"]["candidate_count"], 1)
        self.assertEqual(unmarked_result["meta"]["mark_filter"], "unmarked")

    def test_review_recommend_filters_entries_needing_processing(self):
        category_dir = self.vocab_dir / "daily"
        category_dir.mkdir(parents=True, exist_ok=True)
        today = date.today()

        review_vocabulary.save_vocab_file(
            str(category_dir / "ready.json"),
            {
                "word": "ready",
                "createdAt": today.isoformat(),
                "reviews": [],
                "definitions": ["准备好的"],
                "examples": [
                    {
                        "text": "This entry is ready.",
                        "explanation": "这里表示词条内容已经可用。",
                    }
                ],
            },
        )
        review_vocabulary.save_vocab_file(
            str(category_dir / "needs-processing.json"),
            {
                "word": "needs-processing",
                "createdAt": today.isoformat(),
                "reviews": [],
                "definitions": ["待处理"],
                "examples": [
                    {
                        "text": "This entry needs an explanation.",
                        "explanation": "",
                    }
                ],
            },
        )

        result = review_routes.review_recommend(
            review_routes.ReviewRecommendRequest(
                category="daily",
                limit=5,
                mark_filter="needs_processing",
            )
        )

        self.assertEqual(result["recommended"]["word"], "needs-processing")
        self.assertTrue(result["recommended"]["needsProcessing"])
        self.assertEqual(result["meta"]["candidate_count"], 1)
        self.assertEqual(result["meta"]["mark_filter"], "needs_processing")

    def test_refine_file_uses_cached_llm_for_unchanged_file(self):
        category_dir = self.vocab_dir / "daily"
        category_dir.mkdir(parents=True, exist_ok=True)
        review_vocabulary.save_vocab_file(
            str(category_dir / "cached.json"),
            {
                "word": "cached",
                "createdAt": "2026-05-01",
                "reviews": [],
                "definitions": ["缓存的"],
                "examples": [
                    {
                        "text": "This entry can use cached suggestions.",
                        "explanation": "这里表示可以使用缓存建议。",
                    }
                ],
            },
        )

        llm_payload = {
            "entry": [],
            "definitions": [
                {
                    "action": "append",
                    "reason": "test",
                    "suggested": "缓存测试释义",
                }
            ],
            "examples": [],
            "global_notes": [],
        }
        with patch.object(review_routes, "suggest_file_cleaning_with_llm", return_value=llm_payload) as mocked_llm:
            first = review_routes.refine_file(
                review_routes.FileRefineRequest(category="daily", filename="cached.json")
            )
            second = review_routes.refine_file(
                review_routes.FileRefineRequest(category="daily", filename="cached.json")
            )

        self.assertEqual(mocked_llm.call_count, 1)
        self.assertEqual(first["cache"]["status"], "stored")
        self.assertEqual(second["cache"]["status"], "hit")
        self.assertEqual(second["llm"], llm_payload)

    def test_refine_file_includes_lemma_rule_rename_when_llm_misses_it(self):
        category_dir = self.vocab_dir / "daily"
        category_dir.mkdir(parents=True, exist_ok=True)
        review_vocabulary.save_vocab_file(
            str(category_dir / "pledged.json"),
            {
                "word": "pledged",
                "createdAt": "2026-06-02",
                "reviews": [],
                "definitions": ["（过去式）郑重承诺；保证给予"],
                "examples": [
                    {
                        "text": "A millionaire pledged $1 million.",
                        "explanation": "这里的 pledged 表示郑重承诺。",
                        "focusWords": ["pledged"],
                    }
                ],
            },
        )

        llm_payload = {"entry": [], "definitions": [], "examples": [], "global_notes": []}
        with patch.object(review_routes, "suggest_file_cleaning_with_llm", return_value=llm_payload):
            result = review_routes.refine_file(
                review_routes.FileRefineRequest(category="daily", filename="pledged.json", use_cache=False)
            )

        self.assertEqual(
            result["llm"]["entry"],
            [
                {
                    "action": "rename",
                    "suggested_word": "pledge",
                    "reason": "规则识别：pledged 可按“过去式/过去分词回退到动词原形”归并到原型 pledge。",
                    "confidence": 0.93,
                }
            ],
        )

    def test_refine_file_cache_changes_after_saved_content_changes(self):
        category_dir = self.vocab_dir / "daily"
        category_dir.mkdir(parents=True, exist_ok=True)
        review_vocabulary.save_vocab_file(
            str(category_dir / "mutable.json"),
            {
                "word": "mutable",
                "createdAt": "2026-05-01",
                "reviews": [],
                "definitions": ["可变的"],
                "examples": [],
            },
        )

        llm_payload = {"entry": [], "definitions": [], "examples": [], "global_notes": []}
        with patch.object(review_routes, "suggest_file_cleaning_with_llm", return_value=llm_payload) as mocked_llm:
            first = review_routes.refine_file(
                review_routes.FileRefineRequest(category="daily", filename="mutable.json")
            )
            review_routes.save_vocab(
                review_routes.VocabSaveRequest(
                    category="daily",
                    filename="mutable.json",
                    data={
                        "word": "mutable",
                        "createdAt": "2026-05-01",
                        "reviews": [],
                        "definitions": ["可变的", "容易变化的"],
                        "examples": [],
                    },
                )
            )
            second = review_routes.refine_file(
                review_routes.FileRefineRequest(category="daily", filename="mutable.json")
            )

        self.assertEqual(mocked_llm.call_count, 2)
        self.assertEqual(first["cache"]["status"], "stored")
        self.assertEqual(second["cache"]["status"], "stored")
        self.assertNotEqual(first["cache"]["content_hash"], second["cache"]["content_hash"])

    def test_refine_file_cache_survives_non_analysis_metadata_changes(self):
        category_dir = self.vocab_dir / "daily"
        category_dir.mkdir(parents=True, exist_ok=True)
        review_vocabulary.save_vocab_file(
            str(category_dir / "metadata-only.json"),
            {
                "word": "metadata-only",
                "createdAt": "2026-05-01",
                "reviews": [],
                "marked": False,
                "definitions": ["只影响元数据"],
                "examples": [
                    {
                        "text": "Metadata changes should not alter refine suggestions.",
                        "explanation": "这里表示元数据变化不应改变整理建议。",
                    }
                ],
            },
        )

        llm_payload = {"entry": [], "definitions": [], "examples": [], "global_notes": []}
        with patch.object(review_routes, "suggest_file_cleaning_with_llm", return_value=llm_payload) as mocked_llm:
            first = review_routes.refine_file(
                review_routes.FileRefineRequest(category="daily", filename="metadata-only.json")
            )
            review_routes.save_vocab(
                review_routes.VocabSaveRequest(
                    category="daily",
                    filename="metadata-only.json",
                    data={
                        "word": "metadata-only",
                        "createdAt": "2026-05-01",
                        "reviews": [{"date": "2026-05-02", "score": 4}],
                        "marked": True,
                        "definitions": ["只影响元数据"],
                        "examples": [
                            {
                                "text": "Metadata changes should not alter refine suggestions.",
                                "explanation": "这里表示元数据变化不应改变整理建议。",
                            }
                        ],
                    },
                )
            )
            second = review_routes.refine_file(
                review_routes.FileRefineRequest(category="daily", filename="metadata-only.json")
            )

        self.assertEqual(mocked_llm.call_count, 1)
        self.assertEqual(first["cache"]["status"], "stored")
        self.assertEqual(second["cache"]["status"], "hit")
        self.assertEqual(first["cache"]["content_hash"], second["cache"]["content_hash"])

    def test_prefetch_file_refine_writes_and_reuses_cache(self):
        category_dir = self.vocab_dir / "daily"
        category_dir.mkdir(parents=True, exist_ok=True)
        for word in ["alpha", "beta"]:
            review_vocabulary.save_vocab_file(
                str(category_dir / f"{word}.json"),
                {
                    "word": word,
                    "createdAt": "2026-05-01",
                    "reviews": [],
                    "definitions": [f"{word} definition"],
                    "examples": [],
                },
            )

        llm_payload = {"entry": [], "definitions": [], "examples": [], "global_notes": []}
        with patch.object(review_routes, "suggest_file_cleaning_with_llm", return_value=llm_payload) as mocked_llm:
            first = review_routes.prefetch_file_refine(
                review_routes.FileRefinePrefetchRequest(
                    category="daily",
                    filenames=["alpha.json", "beta.json"],
                    limit=2,
                )
            )
            second = review_routes.prefetch_file_refine(
                review_routes.FileRefinePrefetchRequest(
                    category="daily",
                    filenames=["alpha.json", "beta.json"],
                    limit=2,
                )
            )

        self.assertEqual(mocked_llm.call_count, 2)
        self.assertEqual(first["processed"], 2)
        self.assertEqual(first["counts"].get("stored"), 2)
        self.assertEqual(second["counts"].get("hit"), 2)

    def test_add_vocabulary_invalidates_cached_refine_suggestions(self):
        category_dir = self.vocab_dir / "daily"
        category_dir.mkdir(parents=True, exist_ok=True)
        review_vocabulary.save_vocab_file(
            str(category_dir / "cache-add.json"),
            {
                "word": "cache-add",
                "createdAt": "2026-05-01",
                "reviews": [],
                "definitions": ["新增入口缓存失效测试"],
                "examples": [
                    {
                        "text": "This entry has an existing example.",
                        "explanation": "这里表示已有例句。",
                    }
                ],
            },
        )

        llm_payload = {"entry": [], "definitions": [], "examples": [], "global_notes": []}
        with patch.object(review_routes, "suggest_file_cleaning_with_llm", return_value=llm_payload) as mocked_llm:
            first = review_routes.refine_file(
                review_routes.FileRefineRequest(category="daily", filename="cache-add.json")
            )
            routes.add_vocabulary(
                routes.VocabAddRequest(
                    word="cache-add",
                    context="This new example should invalidate cached suggestions.",
                    source="cache invalidation test",
                    fetch_llm=False,
                    fetch_type="all",
                    category="daily",
                    focus_positions=[],
                    llm_result={
                        "examples": [
                            {
                                "text": "This new example should invalidate cached suggestions.",
                                "explanation": "这里表示新增例句会让缓存失效。",
                            }
                        ],
                    },
                    youtube={},
                )
            )
            second = review_routes.refine_file(
                review_routes.FileRefineRequest(category="daily", filename="cache-add.json")
            )

        self.assertEqual(mocked_llm.call_count, 2)
        self.assertEqual(first["cache"]["status"], "stored")
        self.assertEqual(second["cache"]["status"], "stored")
        self.assertNotEqual(first["cache"]["content_hash"], second["cache"]["content_hash"])

    def test_refine_file_does_not_cache_partial_llm_errors(self):
        category_dir = self.vocab_dir / "daily"
        category_dir.mkdir(parents=True, exist_ok=True)
        review_vocabulary.save_vocab_file(
            str(category_dir / "partial-error.json"),
            {
                "word": "partial-error",
                "createdAt": "2026-05-01",
                "reviews": [],
                "definitions": ["部分失败缓存测试"],
                "examples": [
                    {
                        "text": "This example has no explanation yet.",
                        "explanation": "",
                    }
                ],
            },
        )

        llm_payload = {"entry": [], "definitions": [], "examples": [], "global_notes": []}
        generated_examples = [
            {
                "index": 0,
                "action": "rewrite",
                "suggested_explanation": "这里表示例句还没有解释。",
                "reason": "补充缺失解释。",
            }
        ]
        with (
            patch.object(review_routes, "suggest_file_cleaning_with_llm", return_value=llm_payload) as mocked_llm,
            patch.object(
                review_routes,
                "suggest_missing_example_explanations_with_llm",
                side_effect=[RuntimeError("temporary failure"), generated_examples],
            ),
            patch.object(review_routes.logger, "exception"),
        ):
            first = review_routes.refine_file(
                review_routes.FileRefineRequest(category="daily", filename="partial-error.json")
            )
            second = review_routes.refine_file(
                review_routes.FileRefineRequest(category="daily", filename="partial-error.json")
            )

        self.assertEqual(mocked_llm.call_count, 2)
        self.assertEqual(first["cache"]["status"], "error")
        self.assertIn("temporary failure", first["llm_error"])
        self.assertEqual(second["cache"]["status"], "stored")
        self.assertIsNone(second["llm_error"])
        self.assertEqual(second["llm"]["examples"], generated_examples)

    def test_refine_file_ignores_existing_cached_llm_errors(self):
        category_dir = self.vocab_dir / "daily"
        category_dir.mkdir(parents=True, exist_ok=True)
        review_vocabulary.save_vocab_file(
            str(category_dir / "old-error-cache.json"),
            {
                "word": "old-error-cache",
                "createdAt": "2026-05-01",
                "reviews": [],
                "definitions": ["旧错误缓存测试"],
                "examples": [
                    {
                        "text": "This entry should retry old cached failures.",
                        "explanation": "这里表示旧错误缓存应被忽略。",
                    }
                ],
            },
        )

        cache_meta = refine_cache.build_refine_cache_key(
            "daily",
            "old-error-cache.json",
            review_vocabulary.load_vocab_file(str(category_dir / "old-error-cache.json")),
        )
        refine_cache.save_refine_cache(
            cache_meta,
            {"entry": [], "definitions": [], "examples": [], "global_notes": []},
            "old failure",
        )

        llm_payload = {
            "entry": [],
            "definitions": [{"action": "append", "suggested": "重新生成成功"}],
            "examples": [],
            "global_notes": [],
        }
        with patch.object(review_routes, "suggest_file_cleaning_with_llm", return_value=llm_payload) as mocked_llm:
            result = review_routes.refine_file(
                review_routes.FileRefineRequest(category="daily", filename="old-error-cache.json")
            )

        self.assertEqual(mocked_llm.call_count, 1)
        self.assertEqual(result["cache"]["status"], "stored")
        self.assertIsNone(result["llm_error"])
        self.assertEqual(result["llm"], llm_payload)

    def test_list_vocabulary_marks_refine_cached_entries(self):
        category_dir = self.vocab_dir / "daily"
        category_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "word": "cached-marker",
            "createdAt": "2026-05-01",
            "reviews": [],
            "definitions": ["红点缓存标记测试"],
            "examples": [
                {
                    "text": "This entry already has cached refine suggestions.",
                    "explanation": "这里表示已有整理建议缓存。",
                }
            ],
        }
        review_vocabulary.save_vocab_file(str(category_dir / "cached-marker.json"), payload)
        cache_meta = refine_cache.build_refine_cache_key("daily", "cached-marker.json", payload)
        refine_cache.save_refine_cache(
            cache_meta,
            {
                "entry": [],
                "definitions": [{"action": "append", "suggested": "缓存标记"}],
                "examples": [],
                "global_notes": [],
            },
        )

        result = routes.list_vocabulary("daily")
        by_file = {item["file"]: item for item in result["entries"]}

        self.assertTrue(by_file["cached-marker.json"]["refineCached"])
        self.assertTrue(by_file["cached-marker.json"]["refine_cached"])

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

import io
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi import BackgroundTasks
from starlette.datastructures import UploadFile

from api import review_routes, routes
from core import review_vocabulary, storage, tasks, vocabulary


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

        storage.STORAGE_DIR = str(self.storage_dir)
        vocabulary.VOCAB_DIR = str(self.vocab_dir)
        review_vocabulary.VOCAB_DIR = str(self.vocab_dir)
        tasks.TASKS_FILE = str(self.tasks_file)
        tasks.LOCK_FILE = str(self.lock_file)

        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.vocab_dir.mkdir(parents=True, exist_ok=True)
        self.tasks_file.parent.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        storage.STORAGE_DIR = self.original_storage_dir
        vocabulary.VOCAB_DIR = self.original_vocab_dir
        review_vocabulary.VOCAB_DIR = self.original_review_vocab_dir
        tasks.TASKS_FILE = self.original_tasks_file
        tasks.LOCK_FILE = self.original_lock_file
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


if __name__ == "__main__":
    unittest.main()

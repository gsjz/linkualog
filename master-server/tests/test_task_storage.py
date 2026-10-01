import io
import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi import BackgroundTasks, HTTPException
from starlette.datastructures import UploadFile

from api import routes
from core import storage, tasks


class TaskStorageTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        for obj, name, value in (
            (tasks, "TASKS_FILE", str(self.root / "tasks.json")),
            (tasks, "LOCK_FILE", str(self.root / "tasks.lock")),
            (storage, "STORAGE_DIR", str(self.root / "uploads")),
        ):
            patcher = patch.object(obj, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def make_task(self, name="Original", pages=1):
        paths = [storage.save_temp_file(b"fake image", "page.png") for _ in range(pages)]
        return tasks.create_task(name, paths, auto_process=False)

    @staticmethod
    def image_reply():
        return {"raw": "{}", "parsed": {"extracted_text": "OCR text", "marked_text": []}}

    async def test_same_named_uploads_and_deletion_are_independent(self):
        task_ids = []
        for content in (b"first image", b"second image"):
            result = await routes.upload_resource(
                BackgroundTasks(),
                [UploadFile(filename="image.png", file=io.BytesIO(content))],
                taskName="Upload", startPage=1, autoProcess=False,
            )
            task_ids.append(result["task_id"])
        saved = tasks.load_tasks()
        paths = [Path(saved[task_id]["sub_tasks"][0]["path"]) for task_id in task_ids]
        self.assertNotEqual(paths[0], paths[1])
        self.assertEqual(paths[0].read_bytes(), b"first image")
        self.assertEqual(paths[1].read_bytes(), b"second image")
        routes.delete_task(task_ids[0])
        self.assertFalse(paths[0].exists())
        self.assertEqual(paths[1].read_bytes(), b"second image")

    def test_upload_filename_cannot_escape_storage(self):
        target = self.root / "outside.png"
        target.write_bytes(b"existing")
        for filename in (str(target), "../outside.png", "..\\outside.png"):
            path = Path(storage.save_temp_file(b"upload", filename))
            self.assertEqual(path.parent, self.root / "uploads")
            self.assertEqual(path.suffix, ".png")
        self.assertEqual(target.read_bytes(), b"existing")

    def test_delete_keeps_shared_files_from_legacy_tasks(self):
        first_id = self.make_task()
        image_path = tasks.load_tasks()[first_id]["sub_tasks"][0]["path"]
        second_id = tasks.create_task("Legacy duplicate", [image_path])
        routes.delete_task(first_id)
        self.assertTrue(Path(image_path).exists())
        routes.delete_task(second_id)
        self.assertFalse(Path(image_path).exists())

    def test_parallel_task_creation_keeps_every_task(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            task_ids = list(pool.map(lambda index: tasks.create_task(str(index), []), range(24)))
        self.assertEqual(set(tasks.load_tasks()), set(task_ids))

    def test_failed_write_preserves_existing_database(self):
        task_id = self.make_task()
        Path(tasks.TASKS_FILE).chmod(0o640)
        routes.rename_task(task_id, routes.TaskRenameRequest(name="Keep permissions"))
        self.assertEqual(Path(tasks.TASKS_FILE).stat().st_mode & 0o777, 0o640)
        before = Path(tasks.TASKS_FILE).read_text()
        with self.assertRaises(TypeError):
            with tasks.edit_tasks() as saved:
                saved[task_id]["bad"] = object()
        self.assertEqual(Path(tasks.TASKS_FILE).read_text(), before)

    def test_corrupt_database_is_not_silently_replaced_on_upload(self):
        Path(tasks.TASKS_FILE).write_text('{"incomplete":')
        with self.assertRaises(json.JSONDecodeError):
            tasks.create_task("New task", [])
        self.assertEqual(Path(tasks.TASKS_FILE).read_text(), '{"incomplete":')

    def test_ocr_keeps_tasks_renames_and_page_edits_made_during_request(self):
        task_id = self.make_task(pages=2)
        deleted_id = self.make_task("Delete during OCR")
        with tasks.edit_tasks() as saved:
            saved[task_id]["sub_tasks"][0].update(status="completed", parsed_result={"marked_text": []})
        added = []

        def during_ocr(*args, **kwargs):
            added.append(self.make_task("Concurrent upload"))
            routes.rename_task(task_id, routes.TaskRenameRequest(name="Renamed"))
            routes.delete_task(deleted_id)
            routes.update_task_page_parsed_result(task_id, 0, routes.TaskPageParsedResultRequest(
                parsed_result={"marked_text": [{"word": "manual"}]},
            ))
            return self.image_reply()

        with patch.object(routes, "process_image", side_effect=during_ocr):
            routes.process_task_background(task_id)
        saved = tasks.load_tasks()
        self.assertIn(added[0], saved)
        self.assertNotIn(deleted_id, saved)
        self.assertEqual(saved[task_id]["name"], "Renamed")
        self.assertEqual(saved[task_id]["completed"], 2)
        self.assertEqual(saved[task_id]["status"], "finished")
        self.assertEqual(saved[task_id]["sub_tasks"][0]["parsed_result"]["marked_text"], [{"word": "manual"}])

    def test_ocr_does_not_resurrect_task_deleted_during_request(self):
        task_id = self.make_task(pages=2)

        def during_ocr(*args, **kwargs):
            routes.delete_task(task_id)
            return self.image_reply()

        with patch.object(routes, "process_image", side_effect=during_ocr) as process:
            routes.process_task_background(task_id)
        self.assertNotIn(task_id, tasks.load_tasks())
        process.assert_called_once()

    def test_duplicate_worker_does_not_call_ocr_or_increment_twice(self):
        task_id = self.make_task()
        started = threading.Event()
        finish = threading.Event()

        def slow_ocr(*args, **kwargs):
            started.set()
            self.assertTrue(finish.wait(5))
            return self.image_reply()

        with patch.object(routes, "process_image", side_effect=slow_ocr) as process:
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(routes.process_task_background, task_id)
                try:
                    self.assertTrue(started.wait(5))
                    second = pool.submit(routes.process_task_background, task_id)
                    second.result(timeout=5)
                    self.assertEqual(tasks.load_tasks()[task_id]["sub_tasks"][0]["status"], "processing")
                finally:
                    finish.set()
                first.result(timeout=5)
        process.assert_called_once()
        self.assertEqual(tasks.load_tasks()[task_id]["completed"], 1)

    def test_local_ocr_merges_into_latest_page_and_task_state(self):
        task_id = self.make_task()
        added = []

        def during_ocr(*args, **kwargs):
            added.append(self.make_task("New task"))
            routes.rename_task(task_id, routes.TaskRenameRequest(name="Renamed"))
            routes.update_task_page_parsed_result(task_id, 0, routes.TaskPageParsedResultRequest(
                parsed_result={"extracted_text": "Edited", "marked_text": [{"word": "manual"}]},
            ))
            return {"parsed": {"marked_text": [{"word": "local", "context": "A local word"}]}}

        with patch.object(routes, "process_image_region", side_effect=during_ocr):
            result = routes.recognize_task_page_region(task_id, 0, routes.LocalRecognitionRequest(
                region={"left": 0.1, "top": 0.2, "width": 0.3, "height": 0.4},
            ))
        saved = tasks.load_tasks()
        self.assertIn(added[0], saved)
        self.assertEqual(saved[task_id]["name"], "Renamed")
        self.assertEqual(result["parsed_result"]["extracted_text"], "Edited")
        self.assertEqual([item["word"] for item in result["parsed_result"]["marked_text"]], ["manual", "local"])

    def test_local_ocr_returns_not_found_when_task_was_deleted(self):
        task_id = self.make_task()

        def during_ocr(*args, **kwargs):
            routes.delete_task(task_id)
            return {"parsed": {"marked_text": []}}

        with patch.object(routes, "process_image_region", side_effect=during_ocr):
            with self.assertRaises(HTTPException) as error:
                routes.recognize_task_page_region(task_id, 0, routes.LocalRecognitionRequest(
                    region={"left": 0.1, "top": 0.2, "width": 0.3, "height": 0.4},
                ))
        self.assertEqual(error.exception.status_code, 404)
        self.assertNotIn(task_id, tasks.load_tasks())

    def test_local_ocr_does_not_merge_outdated_result_after_regeneration(self):
        task_id = self.make_task()

        def during_ocr(*args, **kwargs):
            routes.regenerate_task_item(task_id, routes.RegenerateRequest(index=0), BackgroundTasks())
            with patch.object(routes, "process_image", return_value=self.image_reply()):
                routes.process_task_background(task_id)
            return {"parsed": {"marked_text": [{"word": "outdated"}]}}

        with patch.object(routes, "process_image_region", side_effect=during_ocr):
            with self.assertRaises(HTTPException) as error:
                routes.recognize_task_page_region(task_id, 0, routes.LocalRecognitionRequest(
                    region={"left": 0.1, "top": 0.2, "width": 0.3, "height": 0.4},
                ))
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(tasks.load_tasks()[task_id]["sub_tasks"][0]["parsed_result"]["marked_text"], [])

    def test_worker_revisits_earlier_page_regenerated_during_later_page_ocr(self):
        task_id = self.make_task(pages=2)
        with tasks.edit_tasks() as saved:
            saved[task_id]["sub_tasks"][0]["status"] = "completed"
        calls = []

        def during_ocr(*args, **kwargs):
            calls.append(args[1])
            if len(calls) == 1:
                routes.regenerate_task_item(task_id, routes.RegenerateRequest(index=0), BackgroundTasks())
                routes.process_task_background(task_id)
            return self.image_reply()

        with patch.object(routes, "process_image", side_effect=during_ocr):
            routes.process_task_background(task_id)
        self.assertEqual(len(calls), 2)
        self.assertEqual(tasks.load_tasks()[task_id]["completed"], 2)
        self.assertEqual(tasks.load_tasks()[task_id]["status"], "finished")

    def test_failed_ocr_releases_worker_and_resume_retries_only_failed_page(self):
        task_id = self.make_task(pages=2)
        with patch.object(routes, "process_image", side_effect=[self.image_reply(), RuntimeError("OCR unavailable")]):
            routes.process_task_background(task_id)
        failed = tasks.load_tasks()[task_id]
        self.assertEqual(failed["status"], "paused")
        self.assertEqual(failed["completed"], 1)
        self.assertEqual(failed["sub_tasks"][1]["error"], "OCR unavailable")
        background = BackgroundTasks()
        routes.resume_task(task_id, background)
        self.assertEqual(len(background.tasks), 1)
        with patch.object(routes, "process_image", return_value=self.image_reply()) as process:
            routes.process_task_background(task_id)
        process.assert_called_once()
        saved = tasks.load_tasks()[task_id]
        self.assertEqual(saved["status"], "finished")
        self.assertEqual(saved["completed"], 2)
        self.assertNotIn("error", saved["sub_tasks"][1])

    def test_resume_missing_task_returns_not_found_without_queueing(self):
        background = BackgroundTasks()
        with self.assertRaises(HTTPException) as error:
            routes.resume_task("missing", background)
        self.assertEqual(error.exception.status_code, 404)
        self.assertEqual(background.tasks, [])

    def test_restart_recovers_interrupted_page_and_resume_keeps_completed_pages(self):
        task_id = self.make_task(pages=2)
        completed_result = {"marked_text": [{"word": "keep"}]}
        with tasks.edit_tasks() as saved:
            task = saved[task_id]
            task["status"] = "processing"
            task["sub_tasks"][0].update(status="completed", parsed_result=completed_result)
            task["sub_tasks"][1]["status"] = "processing"
        with patch.object(routes, "process_image", return_value=self.image_reply()) as process:
            self.assertEqual(tasks.recover_interrupted_tasks(), 1)
            process.assert_not_called()
            recovered = tasks.load_tasks()[task_id]
            self.assertEqual(recovered["status"], "paused")
            self.assertEqual(recovered["completed"], 1)
            self.assertEqual(recovered["sub_tasks"][1]["status"], "failed")
            self.assertIn("重启", recovered["sub_tasks"][1]["error"])
            self.assertEqual(recovered["sub_tasks"][0]["parsed_result"], completed_result)
            self.assertEqual(tasks.recover_interrupted_tasks(), 0)
            background = BackgroundTasks()
            routes.resume_task(task_id, background)
            self.assertEqual(len(background.tasks), 1)
            routes.process_task_background(task_id)
            process.assert_called_once()
        self.assertEqual(tasks.load_tasks()[task_id]["status"], "finished")

    def test_restart_recovers_regenerate_and_pending_queue_without_running_ocr(self):
        task_id = self.make_task()
        queued_id = self.make_task("Queued")
        collected_id = self.make_task("Only collected")
        with tasks.edit_tasks() as saved:
            saved[task_id]["status"] = "processing"
            saved[task_id]["sub_tasks"][0]["status"] = "processing"
            saved[queued_id]["status"] = "pending"
        self.assertEqual(tasks.recover_interrupted_tasks(), 2)
        saved = tasks.load_tasks()
        self.assertEqual(saved[queued_id]["status"], "paused")
        self.assertEqual(saved[collected_id]["status"], "collected")
        background = BackgroundTasks()
        routes.regenerate_task_item(task_id, routes.RegenerateRequest(index=0), background)
        self.assertEqual(len(background.tasks), 1)
        self.assertEqual(tasks.load_tasks()[task_id]["sub_tasks"][0]["status"], "pending")
        with patch.object(routes, "process_image", return_value=self.image_reply()) as process:
            routes.process_task_background(task_id)
        process.assert_called_once()
        self.assertEqual(tasks.load_tasks()[task_id]["status"], "finished")

    def test_restart_leaves_task_with_active_worker_unchanged(self):
        task_id = self.make_task()
        with tasks.edit_tasks() as saved:
            saved[task_id]["status"] = "processing"
            saved[task_id]["sub_tasks"][0]["status"] = "processing"
        before = tasks.load_tasks()
        with tasks.task_processing_lock(task_id):
            self.assertEqual(tasks.recover_interrupted_tasks(), 0)
        self.assertEqual(tasks.load_tasks(), before)

    def test_restart_finishes_task_when_all_pages_were_already_saved(self):
        task_id = self.make_task()
        with tasks.edit_tasks() as saved:
            saved[task_id]["status"] = "processing"
            saved[task_id]["sub_tasks"][0]["status"] = "completed"
        self.assertEqual(tasks.recover_interrupted_tasks(), 1)
        recovered = tasks.load_tasks()[task_id]
        self.assertEqual(recovered["status"], "finished")
        self.assertEqual(recovered["completed"], 1)

    async def test_app_startup_recovers_tasks_without_starting_ocr(self):
        from main import app

        task_id = self.make_task()
        with tasks.edit_tasks() as saved:
            saved[task_id]["status"] = "processing"
            saved[task_id]["sub_tasks"][0]["status"] = "processing"
        with patch.object(routes, "process_image") as process:
            async with app.router.lifespan_context(app):
                self.assertEqual(tasks.load_tasks()[task_id]["status"], "paused")
            process.assert_not_called()


if __name__ == "__main__":
    unittest.main()

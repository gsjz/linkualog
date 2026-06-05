import base64
import os
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

from api import routes
from services import llm


class FakeResponse:
    def raise_for_status(self):
        return None

    def json(self):
        return {
            "choices": [
                {
                    "message": {
                        "content": '{"t":"The highlighted word is abandon.","m":[{"w":"abandon","c":"The highlighted word is abandon.","b":null}]}'
                    }
                }
            ]
        }


class ImageLLMFlowTests(unittest.TestCase):
    def test_bbox_normalization_uses_one_scale_for_whole_box(self):
        bbox = llm.normalize_unit_bbox({
            "left": 420,
            "top": 315,
            "width": 55,
            "height": 22,
        })

        self.assertEqual(
            bbox,
            {
                "left": 0.42,
                "top": 0.315,
                "width": 0.055,
                "height": 0.022,
            },
        )

    def test_local_bbox_maps_back_to_page_region(self):
        mapped = llm._map_crop_bbox_to_page(
            {"l": 0.25, "t": 0.5, "w": 0.2, "h": 0.1},
            {"left": 0.1, "top": 0.2, "width": 0.5, "height": 0.4},
        )

        self.assertAlmostEqual(mapped["left"], 0.225)
        self.assertAlmostEqual(mapped["top"], 0.4)
        self.assertAlmostEqual(mapped["width"], 0.1)
        self.assertAlmostEqual(mapped["height"], 0.04)

    def test_local_region_route_appends_source_metadata(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            image_path = os.path.join(tmp_dir, "page.jpg")
            Image.new("RGB", (200, 100), "white").save(image_path, "JPEG")
            task_id = "task-local"
            tasks = {
                task_id: {
                    "name": "局部测试",
                    "sub_tasks": [
                        {
                            "path": image_path,
                            "status": "completed",
                            "parsed_result": {
                                "extracted_text": "Existing page text",
                                "marked_text": [],
                            },
                        }
                    ],
                }
            }

            with (
                patch.object(routes, "load_tasks", return_value=tasks),
                patch.object(routes, "save_tasks") as save_tasks,
                patch.object(
                    routes,
                    "process_image_region",
                    return_value={
                        "raw": "{}",
                        "parsed": {
                            "marked_text": [
                                {
                                    "word": "localized",
                                    "context": "A localized example.",
                                    "bbox": {
                                        "left": 0.2,
                                        "top": 0.3,
                                        "width": 0.1,
                                        "height": 0.2,
                                    },
                                    "localBbox": {
                                        "left": 0.25,
                                        "top": 0.25,
                                        "width": 0.5,
                                        "height": 0.5,
                                    },
                                }
                            ]
                        },
                        "meta": {},
                    },
                ),
            ):
                response = routes.recognize_task_page_region(
                    task_id,
                    0,
                    routes.LocalRecognitionRequest(region={
                        "left": 0.1,
                        "top": 0.2,
                        "width": 0.4,
                        "height": 0.5,
                    }),
                )

            self.assertEqual(response["status"], "success")
            self.assertEqual(response["marks"][0]["word"], "localized")
            self.assertEqual(response["marks"][0]["sourceType"], "local-region")
            self.assertEqual(response["marks"][0]["sourceLabel"], "局部识别")
            self.assertEqual(
                response["marks"][0]["sourceRegion"],
                {"left": 0.1, "top": 0.2, "width": 0.4, "height": 0.5},
            )
            self.assertTrue(response["marks"][0]["sourceRegionId"].startswith("page-0-local-"))
            save_tasks.assert_called_once()

    def test_image_processing_continues_when_connectivity_probe_fails(self):
        captured_payloads = []

        def fake_post(url, headers, json, timeout):
            captured_payloads.append(json)
            return FakeResponse()

        with (
            patch.object(
                llm,
                "get_config_data",
                return_value={
                    "api_key": "test-key",
                    "provider": "https://provider.example/v1",
                    "model": "vision-model",
                },
            ),
            patch.object(llm, "test_llm_connection", return_value=False),
            patch.object(llm, "optimize_image", return_value=b"optimized-image"),
            patch.object(llm.requests, "post", side_effect=fake_post),
        ):
            result = llm.process_image(
                b"raw-image",
                "sample.jpg",
                "image/jpeg",
                experimental_coordinates=True,
            )

        self.assertEqual(result["parsed"]["marked_text"][0]["word"], "abandon")
        self.assertEqual(len(captured_payloads), 1)
        image_url = captured_payloads[0]["messages"][0]["content"][1]["image_url"]["url"]
        self.assertEqual(
            image_url,
            "data:image/jpeg;base64," + base64.b64encode(b"optimized-image").decode("utf-8"),
        )


if __name__ == "__main__":
    unittest.main()

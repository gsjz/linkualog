import base64
import unittest
from unittest.mock import patch

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

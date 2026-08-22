import unittest
from unittest.mock import patch

from services import llm_diagnostics


class FakeSocket:
    def close(self):
        return None


class FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = text or ""

    def json(self):
        return self._payload


class LlmDiagnosticsTests(unittest.TestCase):
    def test_connectivity_uses_draft_provider_and_socket_probe(self):
        with (
            patch.object(
                llm_diagnostics,
                "get_config_data",
                return_value={
                    "provider": "https://saved.example/v1",
                    "model": "saved-model",
                    "api_key": "saved-key",
                    "review_llm_connectivity_timeout_seconds": 3,
                },
            ),
            patch.object(llm_diagnostics.socket, "create_connection", return_value=FakeSocket()) as create_connection,
        ):
            result = llm_diagnostics.run_llm_config_connectivity_test({
                "provider": "https://draft.example/v1",
                "model": "draft-model",
            })

        self.assertTrue(result["ok"])
        self.assertEqual(result["request_url"], "https://draft.example/v1/chat/completions")
        create_connection.assert_called_once_with(("draft.example", 443), timeout=3.0)

    def test_minimal_test_uses_saved_key_when_draft_key_is_blank(self):
        captured = {}

        def fake_post(url, headers, json, timeout):
            captured["url"] = url
            captured["headers"] = headers
            captured["json"] = json
            captured["timeout"] = timeout
            return FakeResponse(
                payload={
                    "choices": [
                        {
                            "message": {
                                "content": '{"ok": true}',
                            },
                        },
                    ],
                },
            )

        with (
            patch.object(
                llm_diagnostics,
                "get_config_data",
                return_value={
                    "provider": "https://saved.example/v1",
                    "model": "saved-model",
                    "api_key": "saved-key",
                    "review_llm_timeout_seconds": 75,
                },
            ),
            patch.object(llm_diagnostics.requests, "post", side_effect=fake_post),
        ):
            result = llm_diagnostics.run_llm_config_minimal_test({
                "provider": "https://draft.example/v1",
                "model": "draft-model",
                "api_key": "",
                "review_llm_timeout_seconds": 12,
            })

        self.assertTrue(result["ok"])
        self.assertEqual(captured["url"], "https://draft.example/v1/chat/completions")
        self.assertEqual(captured["headers"]["Authorization"], "Bearer saved-key")
        self.assertEqual(captured["json"]["model"], "draft-model")
        self.assertEqual(captured["timeout"], (4.0, 12.0))

    def test_responses_endpoint_provider_returns_actionable_warning(self):
        with (
            patch.object(
                llm_diagnostics,
                "get_config_data",
                return_value={
                    "provider": "https://saved.example/v1",
                    "model": "saved-model",
                    "api_key": "saved-key",
                    "review_llm_connectivity_timeout_seconds": 3,
                },
            ),
            patch.object(llm_diagnostics.socket, "create_connection", return_value=FakeSocket()),
        ):
            result = llm_diagnostics.run_llm_config_connectivity_test({
                "provider": "https://draft.example/v1/responses",
                "model": "draft-model",
            })

        self.assertTrue(result["ok"])
        self.assertEqual(result["request_url"], "https://draft.example/v1/responses/chat/completions")
        self.assertTrue(any("/responses/chat/completions" in warning for warning in result["warnings"]))


if __name__ == "__main__":
    unittest.main()

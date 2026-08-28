import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from api import routes
from core import config
from core.llm_provider import resolve_chat_completions_url


class ConfigResetTests(unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.tempdir = TemporaryDirectory()
        self.config_file = Path(self.tempdir.name) / "llm_config.json"
        self.original_config_file = config.CONFIG_FILE
        self.original_env = {
            key: os.environ.get(key)
            for key in (
                "MASTER_SERVER_LLM_PROVIDER",
                "MASTER_SERVER_LLM_MODEL",
                "MASTER_SERVER_LLM_API_KEY",
                "MASTER_SERVER_BACKEND_PORT",
                "MASTER_SERVER_TTS_VOICE_SOURCE_PREFERENCE",
                "MASTER_SERVER_TTS_VOICE_PRIORITY",
            )
        }

        config.CONFIG_FILE = self.config_file
        os.environ["MASTER_SERVER_LLM_PROVIDER"] = "https://env.example/v1/chat/completions"
        os.environ["MASTER_SERVER_LLM_MODEL"] = "env-model"
        os.environ["MASTER_SERVER_LLM_API_KEY"] = "env-key"
        os.environ["MASTER_SERVER_BACKEND_PORT"] = "19090"
        os.environ.pop("MASTER_SERVER_TTS_VOICE_SOURCE_PREFERENCE", None)
        os.environ.pop("MASTER_SERVER_TTS_VOICE_PRIORITY", None)

    def tearDown(self):
        config.CONFIG_FILE = self.original_config_file
        for key, value in self.original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tempdir.cleanup()
        super().tearDown()

    def test_reset_config_removes_local_overrides_and_returns_public_defaults(self):
        self.config_file.write_text(
            json.dumps(
                {
                    "provider": "https://saved.example/v1/chat/completions",
                    "model": "saved-model",
                    "api_key": "saved-key",
                    "backend_port": 18081,
                }
            ),
            encoding="utf-8",
        )

        result = routes.reset_config()

        self.assertEqual(result["status"], "success")
        self.assertFalse(self.config_file.exists())
        self.assertEqual(result["data"]["provider"], "https://env.example/v1/chat/completions")
        self.assertEqual(result["data"]["model"], "env-model")
        self.assertEqual(result["data"]["backend_port"], 19090)
        self.assertTrue(result["data"]["hasKey"])
        self.assertNotIn("api_key", result["data"])
        self.assertNotIn("config_file", result["data"])

    def test_provider_base_url_is_preserved_in_config_but_resolves_to_chat_completions(self):
        os.environ["MASTER_SERVER_LLM_PROVIDER"] = "https://env.example/v1"

        result = routes.reset_config()

        self.assertEqual(result["data"]["provider"], "https://env.example/v1")
        self.assertEqual(
            resolve_chat_completions_url(result["data"]["provider"]),
            "https://env.example/v1/chat/completions",
        )

    def test_tts_voice_config_is_saved_and_reset_with_public_data(self):
        os.environ["MASTER_SERVER_TTS_VOICE_SOURCE_PREFERENCE"] = "remote_first"
        os.environ["MASTER_SERVER_TTS_VOICE_PRIORITY"] = "Env Voice, local:en-US"

        initial = routes.get_config()

        self.assertEqual(initial["tts_voice_source_preference"], "remote_first")
        self.assertEqual(initial["tts_voice_priority"], "Env Voice, local:en-US")

        saved = routes.update_config(
            {
                "tts_voice_source_preference": "browser_default",
                "tts_voice_priority": "  Microsoft Aria, en-GB  ",
            }
        )

        self.assertEqual(saved["status"], "success")
        self.assertEqual(saved["data"]["tts_voice_source_preference"], "browser_default")
        self.assertEqual(saved["data"]["tts_voice_priority"], "Microsoft Aria, en-GB")
        self.assertNotIn("api_key", saved["data"])

        raw_saved = json.loads(self.config_file.read_text(encoding="utf-8"))
        self.assertEqual(raw_saved["tts_voice_source_preference"], "browser_default")
        self.assertEqual(raw_saved["tts_voice_priority"], "Microsoft Aria, en-GB")

        reset = routes.reset_config()

        self.assertEqual(reset["data"]["tts_voice_source_preference"], "remote_first")
        self.assertEqual(reset["data"]["tts_voice_priority"], "Env Voice, local:en-US")

    def test_invalid_tts_voice_source_falls_back_to_default(self):
        saved = routes.update_config(
            {
                "tts_voice_source_preference": "not-a-source",
                "tts_voice_priority": "  ",
            }
        )

        self.assertEqual(saved["data"]["tts_voice_source_preference"], "local_first")
        self.assertEqual(saved["data"]["tts_voice_priority"], "")


if __name__ == "__main__":
    unittest.main()

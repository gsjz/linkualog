import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from api import routes
from core import config


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
            )
        }

        config.CONFIG_FILE = self.config_file
        os.environ["MASTER_SERVER_LLM_PROVIDER"] = "https://env.example/v1/chat/completions"
        os.environ["MASTER_SERVER_LLM_MODEL"] = "env-model"
        os.environ["MASTER_SERVER_LLM_API_KEY"] = "env-key"
        os.environ["MASTER_SERVER_BACKEND_PORT"] = "19090"

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


if __name__ == "__main__":
    unittest.main()

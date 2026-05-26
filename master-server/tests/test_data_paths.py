import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from core import data_paths


class DataPathTests(unittest.TestCase):
    def test_default_vocabulary_dir_is_under_data_vocabulary(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                data_paths.get_vocabulary_dir(),
                data_paths.REPO_ROOT / "data" / "vocabulary",
            )

    def test_explicit_vocabulary_dir_is_used_directly(self):
        with TemporaryDirectory() as tmp_dir:
            vocab_dir = Path(tmp_dir) / "data" / "vocabulary"
            with patch.dict(os.environ, {"VOCAB_DIR": str(vocab_dir)}, clear=True):
                self.assertEqual(data_paths.get_vocabulary_dir(), vocab_dir)

    def test_legacy_data_root_vocab_dir_points_to_vocabulary_child(self):
        with TemporaryDirectory() as tmp_dir:
            data_root = Path(tmp_dir) / "data"
            with patch.dict(os.environ, {"VOCAB_DIR": str(data_root)}, clear=True):
                self.assertEqual(data_paths.get_vocabulary_dir(), data_root / "vocabulary")


if __name__ == "__main__":
    unittest.main()

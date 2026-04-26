import json
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data"

QQ_CONNECTOR_E2E_MARKERS = (
    "qqe2e-session",
    "qq connector live e2e",
    "qq connector pre-deploy",
    "qq connector post-deploy",
    "This connector test should write into linkualog.",
    "qq pre-deploy add check",
    "qq post-deploy add check",
)


class RepositoryDataHygieneTests(unittest.TestCase):
    def iter_vocab_files(self) -> list[Path]:
        return sorted(DATA_DIR.glob("*/*.json"))

    def test_tracked_data_has_no_qq_connector_e2e_markers(self):
        offenders: list[str] = []

        for path in self.iter_vocab_files():
            text = path.read_text(encoding="utf-8")
            matched = [marker for marker in QQ_CONNECTOR_E2E_MARKERS if marker in text]
            if matched:
                offenders.append(f"{path.relative_to(REPO_ROOT)} -> {', '.join(matched)}")

        self.assertEqual(
            offenders,
            [],
            "Tracked dataset contains QQ connector e2e samples:\n" + "\n".join(offenders),
        )

    def test_tracked_data_has_no_placeholder_fixture_entries(self):
        offenders: list[str] = []

        for path in self.iter_vocab_files():
            payload = json.loads(path.read_text(encoding="utf-8"))
            if str(payload.get("word") or "").strip().lower() != "test":
                continue

            examples = payload.get("examples")
            if not isinstance(examples, list):
                continue

            has_placeholder_example = False
            has_placeholder_source = False
            for example in examples:
                if not isinstance(example, dict):
                    continue
                if str(example.get("text") or "").strip().lower() == "test":
                    has_placeholder_example = True
                source = example.get("source")
                if isinstance(source, dict) and str(source.get("text") or "").strip().lower() == "example.com":
                    has_placeholder_source = True

            if has_placeholder_example and has_placeholder_source:
                offenders.append(str(path.relative_to(REPO_ROOT)))

        self.assertEqual(
            offenders,
            [],
            "Tracked dataset contains placeholder fixture vocab entries:\n" + "\n".join(offenders),
        )


if __name__ == "__main__":
    unittest.main()

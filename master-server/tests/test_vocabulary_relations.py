import unittest
from datetime import date, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import core.review_vocabulary as review_vocabulary
from core import refine_cache
from core.review_analysis_jobs import reset_analysis_jobs_for_tests, wait_for_analysis_job
from api.review_routes import (
    CombinedPrefetchRequest,
    VocabDeleteRequest,
    ManualVocabMergeRequest,
    RelationSuggestPrefetchRequest,
    RelationSuggestRequest,
    SplitApplyRequest,
    VocabSaveRequest,
    VocabRenameRequest,
    VocabularySearchRequest,
    apply_split,
    delete_vocab,
    manual_merge_vocab,
    rename_vocab,
    review_visualization,
    save_vocab,
    search_vocabulary,
    start_vocab_combined_prefetch_job,
    start_vocab_relations_prefetch_job,
    start_vocab_relations_suggest_job,
    suggest_vocab_relations,
)


def write_vocab(root: Path, category: str, filename: str, payload: dict) -> None:
    category_dir = root / category
    category_dir.mkdir(parents=True, exist_ok=True)
    review_vocabulary.save_vocab_file(str(category_dir / filename), payload)


class VocabularyRelationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.refine_cache_dir = self.root / ".refine_cache"
        self.vocab_patch = patch.object(review_vocabulary, "VOCAB_DIR", str(self.root))
        self.original_refine_cache_dir = refine_cache.REFINE_CACHE_DIR
        self.vocab_patch.start()
        refine_cache.REFINE_CACHE_DIR = self.refine_cache_dir
        reset_analysis_jobs_for_tests()

    def tearDown(self):
        reset_analysis_jobs_for_tests()
        refine_cache.REFINE_CACHE_DIR = self.original_refine_cache_dir
        self.vocab_patch.stop()
        self.tmp.cleanup()

    def test_rename_preserves_display_word_spaces_when_filename_slug_matches(self):
        write_vocab(
            self.root,
            "daily",
            "go-off-tone.json",
            {
                "word": "go-off-tone",
                "createdAt": "2026-04-29",
                "reviews": [],
                "definitions": ["走调"],
                "examples": [{"text": "going off tone", "focusWords": ["go-off-tone"]}],
            },
        )

        body = rename_vocab(
            VocabRenameRequest(
                category="daily",
                filename="go-off-tone.json",
                word="go off tone",
                data={
                    "word": "go off tone",
                    "createdAt": "2026-04-29",
                    "reviews": [],
                    "definitions": ["走调"],
                    "examples": [{"text": "going off tone", "focusWords": ["go off tone"]}],
                },
            )
        )

        self.assertEqual(body["file"], "go-off-tone.json")
        self.assertEqual(body["data"]["word"], "go off tone")
        saved = review_vocabulary.load_vocab_file(str(self.root / "daily" / "go-off-tone.json"))
        self.assertEqual(saved["word"], "go off tone")

    def test_split_apply_endpoint_is_removed(self):
        write_vocab(
            self.root,
            "daily",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-17",
                "reviews": [{"date": "2026-05-20", "score": 3}],
                "definitions": ["危害；危险；风险"],
                "examples": [
                    {
                        "text": "Pesticides create hazards for farmworkers.",
                        "explanation": "hazards 指风险。",
                        "focusWords": ["hazards"],
                    },
                    {
                        "text": "Do you want to hazard a guess?",
                        "explanation": "hazard a guess 是固定表达。",
                        "focusWords": ["hazard"],
                    },
                ],
            },
        )

        with self.assertRaises(Exception) as ctx:
            apply_split(
                SplitApplyRequest(
                    category="daily",
                    source_filename="hazard.json",
                    delete_source=True,
                    suggestion={
                        "action": "split",
                        "reason": "名词 hazard 和固定短语 hazard a guess 应分开。",
                        "suggested_entries": [
                            {
                                "word": "hazard",
                                "definitions": ["危害；危险；风险"],
                                "focus_words": ["hazards"],
                                "example_indices": [0],
                            },
                            {
                                "word": "hazard a guess",
                                "definitions": ["冒昧猜一下；试着猜一猜"],
                                "focus_words": ["hazard a guess"],
                                "example_indices": [1],
                            },
                        ],
                    },
                )
            )

        self.assertEqual(getattr(ctx.exception, "status_code", None), 410)
        self.assertTrue((self.root / "daily" / "hazard.json").exists())
        self.assertFalse((self.root / "daily" / "hazard-a-guess.json").exists())

    def test_visualization_graph_includes_json_and_cross_category_same_word_edges(self):
        write_vocab(
            self.root,
            "daily",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-17",
                "reviews": [],
                "definitions": ["危害"],
                "examples": [],
                "relations": [
                    {
                        "type": "phrase",
                        "target": {
                            "category": "daily",
                            "file": "hazard-a-guess.json",
                            "word": "hazard a guess",
                        },
                    }
                ],
            },
        )
        write_vocab(
            self.root,
            "daily",
            "hazard-a-guess.json",
            {
                "word": "hazard a guess",
                "createdAt": "2026-05-17",
                "reviews": [],
                "definitions": ["试着猜"],
                "examples": [],
            },
        )
        write_vocab(
            self.root,
            "cet",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-18",
                "reviews": [],
                "definitions": ["风险"],
                "examples": [],
            },
        )

        graph = review_visualization()["graph"]
        self.assertEqual(graph["component_count"], 1)
        component = graph["components"][0]
        node_ids = {node["id"] for node in component["nodes"]}
        self.assertEqual(
            node_ids,
            {"daily/hazard.json", "daily/hazard-a-guess.json", "cet/hazard.json"},
        )
        scopes = {edge["scope"] for edge in component["edges"]}
        self.assertIn("same_category", scopes)
        self.assertIn("cross_category", scopes)

    def test_visualization_graph_recommends_top_five_components_by_review_priority(self):
        today = date.today()

        for index in range(6):
            created_at = (today - timedelta(days=index)).isoformat()
            write_vocab(
                self.root,
                "daily",
                f"priority-{index}-a.json",
                {
                    "word": f"priority-{index}-a",
                    "createdAt": created_at,
                    "reviews": [],
                    "definitions": [],
                    "examples": [],
                    "relations": [
                        {
                            "type": "related",
                            "target": {
                                "category": "daily",
                                "file": f"priority-{index}-b.json",
                                "word": f"priority-{index}-b",
                            },
                        }
                    ],
                },
            )
            write_vocab(
                self.root,
                "daily",
                f"priority-{index}-b.json",
                {
                    "word": f"priority-{index}-b",
                    "createdAt": created_at,
                    "reviews": [],
                    "definitions": [],
                    "examples": [],
                },
            )

        with patch("api.review_routes.get_config_data", return_value={}):
            graph = review_visualization(category="daily")["graph"]

        self.assertEqual(graph["available_component_count"], 6)
        self.assertEqual(graph["component_count"], 5)
        self.assertEqual(graph["selection"]["mode"], "recommended")
        component_words = [
            {node["word"] for node in component["nodes"]}
            for component in graph["components"]
        ]
        self.assertEqual(
            component_words,
            [
                {"priority-0-a", "priority-0-b"},
                {"priority-1-a", "priority-1-b"},
                {"priority-2-a", "priority-2-b"},
                {"priority-3-a", "priority-3-b"},
                {"priority-4-a", "priority-4-b"},
            ],
        )
        self.assertEqual(graph["components"][0]["review_priority"]["rank"], 1)
        self.assertGreater(
            graph["components"][0]["review_priority"]["max_score"],
            graph["components"][-1]["review_priority"]["max_score"],
        )

    def test_visualization_graph_refresh_samples_other_five_components(self):
        today = date.today()

        for index in range(10):
            created_at = (today - timedelta(days=index)).isoformat()
            write_vocab(
                self.root,
                "daily",
                f"refresh-{index}-a.json",
                {
                    "word": f"refresh-{index}-a",
                    "createdAt": created_at,
                    "reviews": [],
                    "definitions": [],
                    "examples": [],
                    "relations": [
                        {
                            "type": "related",
                            "target": {
                                "category": "daily",
                                "file": f"refresh-{index}-b.json",
                                "word": f"refresh-{index}-b",
                            },
                        }
                    ],
                },
            )
            write_vocab(
                self.root,
                "daily",
                f"refresh-{index}-b.json",
                {
                    "word": f"refresh-{index}-b",
                    "createdAt": created_at,
                    "reviews": [],
                    "definitions": [],
                    "examples": [],
                },
            )

        with patch("api.review_routes.get_config_data", return_value={}):
            graph = review_visualization(
                category="daily",
                graph_random=True,
                graph_seed="fixed-refresh-test",
            )["graph"]

        self.assertEqual(graph["available_component_count"], 10)
        self.assertEqual(graph["component_count"], 5)
        self.assertEqual(graph["selection"]["mode"], "random")
        self.assertTrue(set(graph["selection"]["selected_component_ids"]).isdisjoint(
            set(graph["selection"]["default_component_ids"])
        ))
        selected_words = {node["word"] for component in graph["components"] for node in component["nodes"]}
        self.assertEqual(
            selected_words,
            {
                "refresh-5-a",
                "refresh-5-b",
                "refresh-6-a",
                "refresh-6-b",
                "refresh-7-a",
                "refresh-7-b",
                "refresh-8-a",
                "refresh-8-b",
                "refresh-9-a",
                "refresh-9-b",
            },
        )

    def test_save_normalizes_relation_aliases_and_syncs_reverse_edge(self):
        write_vocab(
            self.root,
            "daily",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-17",
                "reviews": [],
                "definitions": ["危害"],
                "examples": [],
            },
        )
        write_vocab(
            self.root,
            "daily",
            "hazard-a-guess.json",
            {
                "word": "hazard a guess",
                "createdAt": "2026-05-18",
                "reviews": [],
                "definitions": ["试着猜"],
                "examples": [],
            },
        )

        body = save_vocab(
            VocabSaveRequest(
                category="daily",
                filename="hazard.json",
                data={
                    "word": "hazard",
                    "createdAt": "2026-05-17",
                    "reviews": [],
                    "definitions": ["危害"],
                    "examples": [],
                    "links": [
                        {
                            "type": "phrase",
                            "target": {
                                "category": "daily",
                                "file": "hazard-a-guess.json",
                                "word": "hazard a guess",
                            },
                            "reason": "固定短语",
                        }
                    ],
                },
            )
        )

        self.assertIn("relations", body["data"])
        self.assertNotIn("links", body["data"])
        phrase = review_vocabulary.load_vocab_file(str(self.root / "daily" / "hazard-a-guess.json"))
        self.assertEqual(phrase["relations"][0]["target"]["file"], "hazard.json")
        self.assertEqual(phrase["relations"][0]["type"], "phrase")

    def test_save_relation_removal_clears_reverse_edge(self):
        write_vocab(
            self.root,
            "daily",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-17",
                "reviews": [],
                "definitions": ["危害"],
                "examples": [],
                "relations": [
                    {
                        "type": "phrase",
                        "target": {
                            "category": "daily",
                            "file": "hazard-a-guess.json",
                            "word": "hazard a guess",
                        },
                    }
                ],
            },
        )
        write_vocab(
            self.root,
            "daily",
            "hazard-a-guess.json",
            {
                "word": "hazard a guess",
                "createdAt": "2026-05-18",
                "reviews": [],
                "definitions": ["试着猜"],
                "examples": [],
                "relations": [
                    {
                        "type": "phrase",
                        "target": {
                            "category": "daily",
                            "file": "hazard.json",
                            "word": "hazard",
                        },
                    }
                ],
            },
        )

        save_vocab(
            VocabSaveRequest(
                category="daily",
                filename="hazard.json",
                data={
                    "word": "hazard",
                    "createdAt": "2026-05-17",
                    "reviews": [],
                    "definitions": ["危害"],
                    "examples": [],
                    "relations": [],
                },
            )
        )

        hazard = review_vocabulary.load_vocab_file(str(self.root / "daily" / "hazard.json"))
        phrase = review_vocabulary.load_vocab_file(str(self.root / "daily" / "hazard-a-guess.json"))
        self.assertNotIn("relations", hazard)
        self.assertNotIn("relations", phrase)

    def test_relation_suggest_endpoint_uses_two_step_llm_and_filters_candidates(self):
        write_vocab(
            self.root,
            "daily",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-17",
                "reviews": [],
                "definitions": ["危害"],
                "examples": [{"text": "Do you want to hazard a guess?", "explanation": "固定表达。"}],
            },
        )
        write_vocab(
            self.root,
            "daily",
            "hazard-a-guess.json",
            {
                "word": "hazard a guess",
                "createdAt": "2026-05-18",
                "reviews": [],
                "definitions": ["试着猜"],
                "examples": [],
            },
        )
        write_vocab(
            self.root,
            "cet",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-19",
                "reviews": [],
                "definitions": ["风险"],
                "examples": [],
            },
        )

        with (
            patch("api.review_routes.select_vocab_relation_candidates_with_llm") as mocked_select,
            patch("api.review_routes.suggest_vocab_relations_with_llm") as mocked_confirm,
        ):
            mocked_select.return_value = {
                "selected": {"daily": ["hazard a guess"], "cet": ["hazard"]},
                "notes": [],
            }
            mocked_confirm.return_value = {
                "suggestions": [
                    {
                        "type": "phrase",
                        "target": {
                            "category": "daily",
                            "file": "hazard-a-guess.json",
                            "word": "hazard a guess",
                        },
                        "reason": "固定短语",
                        "confidence": 0.91,
                    }
                ],
                "notes": [],
            }
            body = suggest_vocab_relations(
                RelationSuggestRequest(
                    category="daily",
                    filename="hazard.json",
                    limit=8,
                    custom_prompt="优先固定短语，不要普通同主题词",
                )
            )

        mocked_select.assert_called_once()
        mocked_confirm.assert_called_once()
        self.assertEqual(mocked_select.call_args.kwargs["custom_prompt"], "优先固定短语，不要普通同主题词")
        self.assertEqual(mocked_confirm.call_args.kwargs["custom_prompt"], "优先固定短语，不要普通同主题词")
        confirm_candidates = mocked_confirm.call_args.kwargs["candidates"]
        self.assertLessEqual(len(confirm_candidates), 5)
        self.assertTrue(any(item.get("data", {}).get("word") == "hazard a guess" for item in confirm_candidates))
        self.assertEqual(body["status"], "success")
        self.assertGreaterEqual(body["meta"]["candidate_count"], 2)
        self.assertEqual(body["meta"]["llm_selected_count"], 2)
        targets = {
            (item["type"], item["target"]["category"], item["target"]["file"])
            for item in body["suggestions"]
        }
        self.assertIn(("phrase", "daily", "hazard-a-guess.json"), targets)
        self.assertIn(("same_word", "cet", "hazard.json"), targets)

    def test_relation_suggest_job_returns_result_and_cache(self):
        write_vocab(
            self.root,
            "daily",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-17",
                "reviews": [],
                "definitions": ["危害"],
                "examples": [{"text": "Do you want to hazard a guess?"}],
            },
        )
        write_vocab(
            self.root,
            "daily",
            "hazard-a-guess.json",
            {
                "word": "hazard a guess",
                "createdAt": "2026-05-18",
                "reviews": [],
                "definitions": ["试着猜"],
                "examples": [],
            },
        )

        with (
            patch("api.review_routes.select_vocab_relation_candidates_with_llm") as mocked_select,
            patch("api.review_routes.suggest_vocab_relations_with_llm") as mocked_confirm,
        ):
            mocked_select.return_value = {"selected": {"daily": ["hazard a guess"]}, "notes": []}
            mocked_confirm.return_value = {
                "suggestions": [
                    {
                        "type": "phrase",
                        "target": {
                            "category": "daily",
                            "file": "hazard-a-guess.json",
                            "word": "hazard a guess",
                        },
                        "reason": "固定短语",
                        "confidence": 0.91,
                    }
                ],
                "notes": [],
            }
            queued = start_vocab_relations_suggest_job(
                RelationSuggestRequest(category="daily", filename="hazard.json", limit=8)
            )
            final = wait_for_analysis_job(queued["job_id"], timeout=5)
            cached = suggest_vocab_relations(
                RelationSuggestRequest(category="daily", filename="hazard.json", limit=8)
            )

        self.assertEqual(final["status"], "success")
        self.assertEqual(final["result"]["status"], "success")
        self.assertEqual(final["result"]["cache"]["status"], "stored")
        self.assertEqual(cached["cache"]["status"], "hit")
        self.assertEqual(mocked_select.call_count, 1)
        self.assertEqual(mocked_confirm.call_count, 1)

    def test_relation_prefetch_job_writes_and_reuses_cache(self):
        write_vocab(
            self.root,
            "daily",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-17",
                "reviews": [],
                "definitions": ["危害"],
                "examples": [{"text": "Do you want to hazard a guess?"}],
            },
        )
        write_vocab(
            self.root,
            "daily",
            "hazard-a-guess.json",
            {
                "word": "hazard a guess",
                "createdAt": "2026-05-18",
                "reviews": [],
                "definitions": ["试着猜"],
                "examples": [],
            },
        )

        with (
            patch("api.review_routes.select_vocab_relation_candidates_with_llm") as mocked_select,
            patch("api.review_routes.suggest_vocab_relations_with_llm") as mocked_confirm,
        ):
            mocked_select.return_value = {"selected": {"daily": ["hazard a guess"]}, "notes": []}
            mocked_confirm.return_value = {"suggestions": [], "notes": []}
            queued = start_vocab_relations_prefetch_job(
                RelationSuggestPrefetchRequest(
                    category="daily",
                    filenames=["hazard.json"],
                    limit=1,
                    suggestion_limit=8,
                )
            )
            final = wait_for_analysis_job(queued["job_id"], timeout=5)
            cached = suggest_vocab_relations(
                RelationSuggestRequest(category="daily", filename="hazard.json", limit=8)
            )

        self.assertEqual(final["status"], "success")
        self.assertEqual(final["result"]["processed"], 1)
        self.assertEqual(final["result"]["counts"].get("stored"), 1)
        self.assertEqual(cached["cache"]["status"], "hit")
        self.assertEqual(mocked_select.call_count, 1)
        self.assertEqual(mocked_confirm.call_count, 1)

    def test_relation_suggest_job_marks_llm_error_without_caching(self):
        write_vocab(
            self.root,
            "daily",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-17",
                "reviews": [],
                "definitions": ["危害"],
                "examples": [{"text": "Do you want to hazard a guess?"}],
            },
        )
        write_vocab(
            self.root,
            "daily",
            "hazard-a-guess.json",
            {
                "word": "hazard a guess",
                "createdAt": "2026-05-18",
                "reviews": [],
                "definitions": ["试着猜"],
                "examples": [],
            },
        )

        with patch("api.review_routes.select_vocab_relation_candidates_with_llm", side_effect=RuntimeError("llm down")):
            queued = start_vocab_relations_suggest_job(
                RelationSuggestRequest(category="daily", filename="hazard.json", limit=8)
            )
            final = wait_for_analysis_job(queued["job_id"], timeout=5)

        self.assertEqual(final["status"], "error")
        self.assertIn("llm down", final["error"])
        self.assertEqual(final["result"]["cache"]["status"], "error")
        cached = refine_cache.load_refine_cache(
            refine_cache.build_relation_suggest_cache_key(
                "daily",
                "hazard.json",
                review_vocabulary.load_vocab_file(str(self.root / "daily" / "hazard.json")),
                limit=8,
                candidate_limit=72,
            )
        )
        self.assertIsNone(cached)

    def test_relation_cache_marker_requires_suggestions(self):
        payload = {
            "word": "hazard",
            "createdAt": "2026-05-17",
            "reviews": [],
            "definitions": ["危害"],
            "examples": [],
        }
        write_vocab(self.root, "daily", "hazard.json", payload)
        empty_meta = refine_cache.build_relation_suggest_cache_key("daily", "hazard.json", payload)
        refine_cache.save_refine_cache(
            empty_meta,
            {
                "status": "success",
                "suggestions": [],
                "llm": {"suggestions": [], "notes": []},
            },
        )

        self.assertFalse(
            refine_cache.has_relation_suggest_cache_for_entry("daily", "hazard.json", payload)
        )

        refine_cache.save_refine_cache(
            empty_meta,
            {
                "status": "success",
                "suggestions": [
                    {
                        "type": "related",
                        "target": {
                            "category": "daily",
                            "file": "hazard-a-guess.json",
                            "word": "hazard a guess",
                        },
                    }
                ],
                "llm": {"suggestions": [], "notes": []},
            },
        )

        self.assertTrue(
            refine_cache.has_relation_suggest_cache_for_entry("daily", "hazard.json", payload)
        )

    def test_delete_vocab_removes_file_and_incoming_relations(self):
        write_vocab(
            self.root,
            "daily",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-17",
                "reviews": [],
                "definitions": ["危害"],
                "examples": [],
            },
        )
        write_vocab(
            self.root,
            "daily",
            "hazard-a-guess.json",
            {
                "word": "hazard a guess",
                "createdAt": "2026-05-18",
                "reviews": [],
                "definitions": ["试着猜"],
                "examples": [],
                "relations": [
                    {
                        "type": "phrase",
                        "target": {
                            "category": "daily",
                            "file": "hazard.json",
                            "word": "hazard",
                        },
                    }
                ],
            },
        )

        result = delete_vocab(VocabDeleteRequest(category="daily", filename="hazard.json"))

        self.assertEqual(result["status"], "success")
        self.assertTrue(result["deleted"])
        self.assertEqual(result["updated_relation_files"], 1)
        self.assertFalse((self.root / "daily" / "hazard.json").exists())
        phrase = review_vocabulary.load_vocab_file(str(self.root / "daily" / "hazard-a-guess.json"))
        self.assertNotIn("relations", phrase)

    def test_vocabulary_search_matches_examples_definitions_and_relations(self):
        write_vocab(
            self.root,
            "daily",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-17",
                "reviews": [],
                "definitions": ["危害；危险；风险"],
                "examples": [
                    {
                        "text": "Do you want to hazard a guess?",
                        "explanation": "hazard a guess 是固定表达。",
                        "focusWords": ["hazard"],
                    }
                ],
                "relations": [
                    {
                        "type": "phrase",
                        "target": {
                            "category": "daily",
                            "file": "hazard-a-guess.json",
                            "word": "hazard a guess",
                        },
                        "reason": "固定短语",
                    }
                ],
            },
        )
        write_vocab(
            self.root,
            "daily",
            "hazard-a-guess.json",
            {
                "word": "hazard a guess",
                "createdAt": "2026-05-18",
                "reviews": [],
                "definitions": ["试着猜"],
                "examples": [],
            },
        )

        result = search_vocabulary(
            VocabularySearchRequest(query="风险 guess", category="daily", limit=10)
        )

        self.assertEqual(result["status"], "success")
        result_files = [item["file"] for item in result["results"]]
        self.assertIn("hazard.json", result_files)
        hazard = next(item for item in result["results"] if item["file"] == "hazard.json")
        self.assertGreater(hazard["score"], 0)
        self.assertTrue(hazard["snippet"])

    def test_vocabulary_search_can_use_llm_ranked_candidates(self):
        write_vocab(
            self.root,
            "daily",
            "hazard.json",
            {
                "word": "hazard",
                "definitions": ["危害；危险；风险"],
                "examples": [],
            },
        )
        write_vocab(
            self.root,
            "daily",
            "hazard-a-guess.json",
            {
                "word": "hazard a guess",
                "definitions": ["试着猜"],
                "examples": [{"text": "Do you want to hazard a guess?"}],
            },
        )

        with patch(
            "api.review_routes.search_vocabulary_with_llm",
            return_value={
                "results": [
                    {
                        "id": "daily/hazard-a-guess.json",
                        "score": 0.93,
                        "reason": "LLM 判断该固定表达最符合查询。",
                    }
                ],
                "notes": ["ok"],
            },
        ) as mocked_search:
            result = search_vocabulary(
                VocabularySearchRequest(query="试着猜", category="daily", limit=10, use_llm=True)
            )

        self.assertEqual(result["status"], "success")
        self.assertTrue(result["use_llm"])
        self.assertEqual(result["notes"], ["ok"])
        self.assertEqual([item["file"] for item in result["results"]], ["hazard-a-guess.json"])
        self.assertEqual(result["results"][0]["matched_field"], "llm")
        mocked_search.assert_called_once()
        candidate_ids = {item["id"] for item in mocked_search.call_args.args[1]}
        self.assertEqual(candidate_ids, {"daily/hazard.json", "daily/hazard-a-guess.json"})

    def test_combined_prefetch_job_runs_refine_and_relations_under_one_job(self):
        write_vocab(
            self.root,
            "daily",
            "hazard.json",
            {
                "word": "hazard",
                "createdAt": "2026-05-17",
                "reviews": [],
                "definitions": ["危害"],
                "examples": [{"text": "Do you want to hazard a guess?"}],
            },
        )
        write_vocab(
            self.root,
            "daily",
            "hazard-a-guess.json",
            {
                "word": "hazard a guess",
                "createdAt": "2026-05-18",
                "reviews": [],
                "definitions": ["试着猜"],
                "examples": [],
            },
        )

        with (
            patch("api.review_routes.suggest_file_cleaning_with_llm") as mocked_refine,
            patch("api.review_routes.suggest_missing_example_explanations_with_llm") as mocked_missing_explanations,
            patch("api.review_routes.select_vocab_relation_candidates_with_llm") as mocked_select,
            patch("api.review_routes.suggest_vocab_relations_with_llm") as mocked_confirm,
        ):
            mocked_refine.return_value = {
                "definitions": [
                    {
                        "action": "keep",
                        "index": 0,
                        "text": "危害",
                        "reason": "清晰",
                    }
                ],
                "examples": [],
                "entry": [],
            }
            mocked_missing_explanations.return_value = []
            mocked_select.return_value = {"selected": {"daily": ["hazard a guess"]}, "notes": []}
            mocked_confirm.return_value = {"suggestions": [], "notes": []}
            queued = start_vocab_combined_prefetch_job(
                CombinedPrefetchRequest(category="daily", filenames=["hazard.json"], limit=1)
            )
            final = wait_for_analysis_job(queued["job_id"], timeout=5)

        self.assertEqual(final["status"], "success")
        item = final["result"]["results"][0]
        self.assertEqual(item["status"], "success")
        self.assertEqual(item["refine"]["cache"]["status"], "stored")
        self.assertEqual(item["relations"]["cache"]["status"], "stored")
        self.assertEqual(mocked_refine.call_count, 1)
        self.assertEqual(mocked_select.call_count, 1)
        self.assertEqual(mocked_confirm.call_count, 1)

    def test_manual_merge_rewrites_incoming_undirected_relation_to_target(self):
        write_vocab(
            self.root,
            "daily",
            "irritating.json",
            {
                "word": "irritating",
                "createdAt": "2026-05-17",
                "reviews": [],
                "definitions": ["令人恼火的"],
                "examples": [],
            },
        )
        write_vocab(
            self.root,
            "cet",
            "irritate.json",
            {
                "word": "irritate",
                "createdAt": "2026-05-18",
                "reviews": [],
                "definitions": ["使恼怒"],
                "examples": [],
            },
        )
        write_vocab(
            self.root,
            "daily",
            "annoying.json",
            {
                "word": "annoying",
                "createdAt": "2026-05-19",
                "reviews": [],
                "definitions": ["烦人的"],
                "examples": [],
                "relations": [
                    {
                        "type": "synonym",
                        "target": {
                            "category": "daily",
                            "file": "irritating.json",
                            "word": "irritating",
                        },
                    }
                ],
            },
        )

        result = manual_merge_vocab(
            ManualVocabMergeRequest(
                source_category="daily",
                source_filename="irritating.json",
                target_category="cet",
                target_word="irritate",
                delete_source=True,
                create_target_if_missing=True,
            )
        )

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["rewritten_relation_files"], 1)
        self.assertFalse((self.root / "daily" / "irritating.json").exists())
        annoying = review_vocabulary.load_vocab_file(str(self.root / "daily" / "annoying.json"))
        self.assertEqual(annoying["relations"][0]["type"], "synonym")
        self.assertEqual(annoying["relations"][0]["target"]["category"], "cet")
        self.assertEqual(annoying["relations"][0]["target"]["file"], "irritate.json")


if __name__ == "__main__":
    unittest.main()

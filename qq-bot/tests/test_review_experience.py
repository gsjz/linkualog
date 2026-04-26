import copy
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

QQ_BOT_DIR = Path(__file__).resolve().parents[1]
if str(QQ_BOT_DIR) not in sys.path:
    sys.path.insert(0, str(QQ_BOT_DIR))

import review_teaching as REVIEW_TEACHING


try:
    import websockets  # noqa: F401
except ImportError:
    stub = types.ModuleType("websockets")
    stub.ClientConnection = object
    sys.modules["websockets"] = stub

MODULE_PATH = QQ_BOT_DIR / "main.py"
SPEC = importlib.util.spec_from_file_location("qq_bot_main", MODULE_PATH)
QQBOT = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = QQBOT
assert SPEC.loader is not None
SPEC.loader.exec_module(QQBOT)


class FakeLinkuaLogClient:
    def __init__(self, payload: dict) -> None:
        self.payload = copy.deepcopy(payload)
        initial_word = str(self.payload.get("word") or "abandon").strip() or "abandon"
        initial_filename = f"{QQBOT.normalize_word_key(initial_word) or 'abandon'}.json"
        self.review_item = {
            "key": f"daily/{initial_filename}",
            "category": "daily",
            "file": initial_filename,
            "word": initial_word,
            "reason": "今天到期，适合现在复习。",
            "advice": {"status": "due_today"},
        }
        self.review_suggest_calls: list[dict] = []
        self.save_vocab_calls: list[dict] = []
        self.rename_vocab_calls: list[dict] = []

    def health(self) -> dict:
        return {"status": "ok"}

    def list_categories(self) -> list[str]:
        return ["daily"]

    def review_recommend(self, *, category, exclude_keys, limit=5) -> dict:
        if self.review_item["key"] in set(exclude_keys or []):
            return {"status": "success", "recommended": None, "alternatives": []}
        return {"status": "success", "recommended": copy.deepcopy(self.review_item), "alternatives": []}

    def get_vocab_detail(self, word: str, category: str) -> dict:
        return {
            "status": "success",
            "category": category,
            "word": word,
            "file": self.review_item["file"],
            "data": copy.deepcopy(self.payload),
        }

    def review_suggest(self, *, category: str, filename: str, score: int, auto_save: bool = True) -> dict:
        self.review_suggest_calls.append(
            {
                "category": category,
                "filename": filename,
                "score": score,
                "auto_save": auto_save,
            }
        )
        return {"status": "success"}

    def save_vocab(self, *, category: str, filename: str, data: dict) -> dict:
        self.save_vocab_calls.append(
            {
                "category": category,
                "filename": filename,
                "data": copy.deepcopy(data),
            }
        )
        self.payload = copy.deepcopy(data)
        return {"status": "success", "data": copy.deepcopy(self.payload)}

    def rename_vocab(self, *, category: str, filename: str, word: str, data: dict | None = None) -> dict:
        payload = copy.deepcopy(data) if isinstance(data, dict) else copy.deepcopy(self.payload)
        source_keys = {
            QQBOT.normalize_word_key(Path(filename).stem),
            QQBOT.normalize_word_key(self.payload.get("word")),
        }
        merged_from = payload.get("mergedFrom")
        if not isinstance(merged_from, list):
            merged_from = []
        source_word = QQBOT.normalize_word_key(self.payload.get("word"))
        if source_word and source_word != word and source_word not in merged_from:
            merged_from.append(source_word)
        if merged_from:
            payload["mergedFrom"] = merged_from
        payload["word"] = word
        for example in payload.get("examples", []):
            if not isinstance(example, dict):
                continue
            focus_words = example.get("focusWords")
            if isinstance(focus_words, list):
                example["focusWords"] = [word if QQBOT.normalize_word_key(item) in source_keys else item for item in focus_words]
        for review_session in payload.get("reviewSessions", []):
            if isinstance(review_session, dict) and QQBOT.normalize_word_key(review_session.get("word")) in source_keys:
                review_session["word"] = word

        target_filename = f"{word}.json"
        self.rename_vocab_calls.append(
            {
                "category": category,
                "filename": filename,
                "word": word,
                "data": copy.deepcopy(payload),
            }
        )
        self.payload = payload
        self.review_item["category"] = category
        self.review_item["file"] = target_filename
        self.review_item["key"] = f"{category}/{target_filename}"
        self.review_item["word"] = word
        return {
            "status": "success",
            "category": category,
            "source_file": filename,
            "file": target_filename,
            "target_file": target_filename,
            "word": word,
            "data": copy.deepcopy(self.payload),
        }


class FakeLLMClient:
    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled

    def chat_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int = 500,
        temperature: float = 0.1,
        timeout: float = 60.0,
    ) -> dict:
        if "英语词汇卡片清洗助手" in system_prompt:
            request = json.loads(user_prompt)
            if request.get("word") == "tam":
                return {
                    "word": "tame",
                    "example_text": "They prayed to the stars, tamed fire, and turned stones into tools.",
                    "explanation": "这里表示人类驯服并掌控了火，使其能被使用。",
                    "notes": "目标词应为 tame；原词 tam 不完整。",
                }
            if request.get("word") == "turn":
                return {
                    "word": "turne",
                    "example_text": "They turned stones into tools.",
                    "explanation": "这里表示把石头变成工具。",
                    "notes": "误判成了 turne。",
                }
            if request.get("word") == "lineages":
                return {
                    "word": "lineage",
                    "example_text": "They split into many families and lineages, evolving further or disappearing again.",
                    "explanation": "这里的 lineages 指生物演化中的谱系。",
                    "notes": "目标词应收敛到 lineage。",
                }
            if request.get("word") == "inflate":
                return {
                    "word": "inflat",
                    "example_text": "Putting an inflated price on artifacts rather than viewing them as cultural and historical treasures that transcend any price",
                    "explanation": "这里表示给文物标上虚高的价格。",
                    "notes": "误判成了 inflat。",
                }
            return {
                "word": "abandon",
                "example_text": "We should abandon ship now.",
                "explanation": "这里表示必须立刻弃船撤离。",
                "notes": "已去掉编号和说话人标记。",
            }
        if "英语词汇记忆提示助手" in system_prompt:
            request = json.loads(user_prompt)
            if request.get("word") == "inflate":
                return {
                    "hint": "可以顺手连到 `inflation`：一个偏“使膨胀”，一个常落到“价格被抬高”的结果。"
                }
            return {"hint": ""}
        if "模式3创意输出题" in system_prompt:
            return {
                "title": "创意输出",
                "task": "请写一句英文，表现你在紧急情况下必须 abandon 某个计划。",
                "tips": ["用完整句子", "语境尽量具体"],
            }
        if "模式2场景填空题" in system_prompt:
            return {
                "title": "场景填空",
                "scene": "你在港口听到警报，所有人都在准备撤离。",
                "prompt": "The captain told everyone to _____ ship immediately.",
                "answer_hint": "中文义项和撤离有关",
                "accepted_answers": ["abandon"],
            }
        if "你是英语词汇复习批改器" in system_prompt:
            return {
                "score": 4,
                "feedback": "意思基本答到了，还可以更完整。",
                "matched_points": ["抓住了核心词义"],
                "missing_points": ["还可以补上语境里的用法"],
            }
        raise AssertionError(f"unexpected system prompt: {system_prompt}")


class QQBotReviewExperienceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = TemporaryDirectory()
        self.base_dir = Path(self.tempdir.name)
        self.local_data_dir = self.base_dir / "local"
        self.linkualog_data_dir = self.base_dir / "data"
        self.session_state_file = self.local_data_dir / "session_state.json"
        self.message_seq = 0
        self.local_data_dir.mkdir(parents=True, exist_ok=True)
        (self.linkualog_data_dir / "daily").mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def make_app(
        self,
        *,
        payload: dict,
        llm_enabled: bool,
        llm_client: FakeLLMClient | None = None,
    ) -> tuple[object, FakeLinkuaLogClient]:
        client = FakeLinkuaLogClient(payload)
        llm = llm_client or FakeLLMClient(enabled=llm_enabled)
        app = QQBOT.QQLinkuaLogApp(
            session_state_file=self.session_state_file,
            local_data_dir=self.local_data_dir,
            linkualog_data_dir=self.linkualog_data_dir,
            linkualog_client=client,
            llm_client=llm,
            add_fetch_llm=False,
            route_confidence_threshold=0.72,
        )
        return app, client

    def make_envelope(self, text: str, *, conversation_id: str = "u1") -> dict:
        self.message_seq += 1
        return {
            "platform": "qq",
            "scene": "direct",
            "event_type": "C2C_MESSAGE_CREATE",
            "connector_event_id": f"evt-{self.message_seq}",
            "conversation_id": conversation_id,
            "sender_id": conversation_id,
            "message_id": f"msg-{self.message_seq}",
            "received_at": "2026-04-20T10:00:00",
            "text": text,
            "attachments": [],
            "mentions_bot": False,
            "raw_payload": {},
        }

    def test_status_and_search_render_markdown(self) -> None:
        vocab_path = self.linkualog_data_dir / "daily" / "abandon.json"
        vocab_path.write_text(
            json.dumps(
                {
                    "word": "abandon",
                    "definitions": ["放弃；抛弃"],
                    "examples": [{"text": "They had to abandon the car.", "explanation": "他们不得不弃车。"}],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

        app, _client = self.make_app(payload={"word": "abandon", "definitions": [], "examples": []}, llm_enabled=False)

        status_result = app.handle_envelope(self.make_envelope("\\status"))
        self.assertEqual(status_result.metadata.get("message_format"), "markdown")
        self.assertIn("### 当前状态", status_result.reply_text)

        search_result = app.handle_envelope(self.make_envelope("\\search abandon"))
        self.assertEqual(search_result.metadata.get("message_format"), "markdown")
        self.assertIn("### 查词结果", search_result.reply_text)
        self.assertIn("**abandon**", search_result.reply_text)

    def test_llm_client_adds_lowercase_json_hint_when_missing(self) -> None:
        system_prompt = "请只返回结构化结果。"
        user_prompt = '{"word":"abandon"}'

        safe_prompt = QQBOT.LLMClient.ensure_json_instruction(system_prompt, user_prompt)
        self.assertIn("json", safe_prompt.lower())

        uppercase_prompt = QQBOT.LLMClient.ensure_json_instruction("请只返回 JSON。", user_prompt)
        self.assertIn("Return valid json only.", uppercase_prompt)

    def test_llm_client_retries_when_provider_requires_literal_json_word(self) -> None:
        calls = []
        original_http_json = QQBOT.http_json

        def fake_http_json(method, url, headers=None, data=None, timeout=0):
            assert isinstance(data, dict)
            calls.append(data)
            messages = data.get("messages") or []
            combined = "\n".join(str(item.get("content") or "") for item in messages if isinstance(item, dict))
            if len(calls) == 1:
                raise RuntimeError(
                    "HTTP 400 for https://relay.nf.video/v1/chat/completions: "
                    "{\"error\":{\"message\":\"Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'.\"}}"
                )
            self.assertIn("json", combined)
            return {"choices": [{"message": {"content": "{\"score\": 5}"}}]}

        QQBOT.http_json = fake_http_json
        try:
            client = QQBOT.LLMClient(provider="https://relay.nf.video/v1/chat/completions", model="x", api_key="k", enabled=True)
            result = client.chat_json(system_prompt="请只返回结构化结果。", user_prompt='{"word":"abandon"}')
        finally:
            QQBOT.http_json = original_http_json

        self.assertEqual(result["score"], 5)
        self.assertEqual(len(calls), 2)

    def test_review_mode_persists_and_mode2_can_score_fill_blank(self) -> None:
        payload = {
            "word": "abandon",
            "definitions": ["放弃；抛弃"],
            "examples": [{"text": "The captain gave the order to abandon ship.", "explanation": "船长下令弃船。"}],
        }
        app, client = self.make_app(payload=payload, llm_enabled=True)

        first_review = app.handle_envelope(self.make_envelope("\\review"))
        self.assertEqual(first_review.metadata.get("message_format"), "markdown")
        self.assertIn("模式 1 释义理解", first_review.reply_text)

        mode_switch = app.handle_envelope(self.make_envelope("\\mode 2"))
        self.assertEqual(mode_switch.metadata.get("message_format"), "markdown")
        self.assertIn("模式 2 场景填空", mode_switch.reply_text)

        end_result = app.handle_envelope(self.make_envelope("\\end"))
        self.assertEqual(end_result.metadata.get("status"), "success")

        second_review = app.handle_envelope(self.make_envelope("\\review"))
        self.assertEqual(second_review.metadata.get("message_format"), "markdown")
        self.assertIn("模式 2 场景填空", second_review.reply_text)
        self.assertIn("**切换模式**", second_review.reply_text)
        self.assertIn("- `\\mode 2` **模式 2 · 场景填空（当前）**", second_review.reply_text)
        self.assertIn("- `\\mode 1` 模式 1 · 释义理解", second_review.reply_text)
        self.assertIn("- `\\mode 3` 模式 3 · 创意输出", second_review.reply_text)

        answer_result = app.handle_envelope(self.make_envelope("abandon"))
        self.assertEqual(answer_result.metadata.get("message_format"), "markdown")
        self.assertIn("### 本题反馈", answer_result.reply_text)
        self.assertIn("`5/5`", answer_result.reply_text)
        self.assertEqual(client.review_suggest_calls[-1]["score"], 5)

        session_data = json.loads(self.session_state_file.read_text(encoding="utf-8"))
        review_preferences = session_data["direct:u1"]["review_preferences"]
        self.assertEqual(review_preferences["mode"], 2)

    def test_review_mode2_prompt_falls_back_when_llm_leaks_answer(self) -> None:
        class LeakyFillBlankLLM(FakeLLMClient):
            def chat_json(self, *, system_prompt: str, user_prompt: str, **kwargs) -> dict:
                if "模式2场景填空题" in system_prompt:
                    return {
                        "title": "场景填空",
                        "scene": "你突然听到 abandon 这个命令，所有人都慌了。",
                        "prompt": "The captain said we must abandon ship, so fill in: _____.",
                        "answer_hint": "答案就是 abandon",
                        "accepted_answers": ["abandon"],
                    }
                return super().chat_json(system_prompt=system_prompt, user_prompt=user_prompt, **kwargs)

        payload = {
            "word": "abandon",
            "definitions": ["放弃；抛弃"],
            "examples": [{"text": "The captain gave the order to abandon ship.", "explanation": "船长下令弃船。"}],
        }
        app, _client = self.make_app(payload=payload, llm_enabled=True, llm_client=LeakyFillBlankLLM(enabled=True))

        app.handle_envelope(self.make_envelope("\\mode 2"))
        review_result = app.handle_envelope(self.make_envelope("\\review"))
        self.assertIn("模式 2 场景填空", review_result.reply_text)
        self.assertNotIn("答案就是 abandon", review_result.reply_text)
        self.assertNotIn("你突然听到 abandon 这个命令", review_result.reply_text)

        session = app.session_store.get("direct:u1")
        challenge = session["review"]["current"]["challenge"]
        self.assertEqual(challenge["scene"], "请根据下面的具体场景和语境，回想目标英文词或短语。")
        self.assertNotIn("abandon", challenge["prompt"].lower())
        self.assertNotIn("abandon", challenge["answer_hint"].lower())
        self.assertIn("_____", challenge["prompt"])

    def test_review_mode3_prompt_falls_back_when_llm_task_is_generic(self) -> None:
        class GenericCreativeLLM(FakeLLMClient):
            def chat_json(self, *, system_prompt: str, user_prompt: str, **kwargs) -> dict:
                if "模式3创意输出题" in system_prompt:
                    return {
                        "title": "创意输出",
                        "task": "请用 abandon 造句。",
                        "tips": ["用完整句子", "尽量自然"],
                    }
                return super().chat_json(system_prompt=system_prompt, user_prompt=user_prompt, **kwargs)

        payload = {
            "word": "abandon",
            "definitions": ["放弃；抛弃"],
            "examples": [{"text": "The captain gave the order to abandon ship.", "explanation": "船长下令弃船。"}],
        }
        app, _client = self.make_app(payload=payload, llm_enabled=True, llm_client=GenericCreativeLLM(enabled=True))

        app.handle_envelope(self.make_envelope("\\mode 3"))
        review_result = app.handle_envelope(self.make_envelope("\\review"))
        self.assertIn("模式 3 创意输出", review_result.reply_text)
        self.assertIn("**参考例句**", review_result.reply_text)
        self.assertIn("The captain gave the order to abandon ship.", review_result.reply_text)
        self.assertIn("**你的任务**", review_result.reply_text)
        self.assertIn("**不要这样做**", review_result.reply_text)
        self.assertIn("**输出格式**", review_result.reply_text)

        session = app.session_store.get("direct:u1")
        challenge = session["review"]["current"]["challenge"]
        self.assertNotEqual(challenge["task"], "请用 abandon 造句。")
        self.assertIn("abandon", challenge["task"].lower())
        self.assertIn("不要照抄参考例句", challenge["task"])
        self.assertIn(challenge["template_id"], {item["id"] for item in QQBOT.CREATIVE_REVIEW_TEMPLATES})
        self.assertGreaterEqual(len(challenge["tips"]), 2)
        self.assertTrue(all(tip not in {"用完整句子", "尽量自然"} for tip in challenge["tips"]))

    def test_review_mode3_template_selection_is_stable(self) -> None:
        payload = {
            "word": "abandon",
            "definitions": ["放弃；抛弃"],
            "examples": [{"text": "The captain gave the order to abandon ship.", "explanation": "船长下令弃船。"}],
        }
        app, _client = self.make_app(payload=payload, llm_enabled=False)

        app.handle_envelope(self.make_envelope("\\mode 3"))
        first_review = app.handle_envelope(self.make_envelope("\\review"))
        self.assertIn("模式 3 创意输出", first_review.reply_text)
        self.assertIn("**参考例句**", first_review.reply_text)
        self.assertIn("The captain gave the order to abandon ship.", first_review.reply_text)
        first_session = app.session_store.get("direct:u1")
        first_challenge = first_session["review"]["current"]["challenge"]
        expected_template = QQBOT.select_creative_review_template(first_session["review"]["current"])
        self.assertEqual(first_challenge["template_id"], expected_template["id"])
        self.assertEqual(first_challenge["title"], expected_template["title"])
        self.assertIn("不要照抄参考例句", first_challenge["task"])
        self.assertIn("abandon", first_challenge["task"].lower())
        self.assertEqual(first_challenge["template_id"], REVIEW_TEACHING.select_creative_review_template(first_session["review"]["current"])["id"])

    def test_review_mode3_prefers_food_texture_template_for_crunchy(self) -> None:
        payload = {
            "word": "crunchy",
            "definitions": ["adj. 酥脆的"],
            "examples": [
                {
                    "text": "Picture warm, gooey cookies, crunchy candies, velvety cakes, waffle cones piled high with ice cream. Is your mouth watering?",
                    "explanation": "想象一下温热的、软糯的饼干，酥脆的糖果，丝绒般的蛋糕，以及堆满冰淇淋的华夫筒。你的口水是不是流出来了？",
                }
            ],
        }
        app, _client = self.make_app(payload=payload, llm_enabled=False)

        app.handle_envelope(self.make_envelope("\\mode 3"))
        review_result = app.handle_envelope(self.make_envelope("\\review"))
        self.assertIn("模式 3 创意输出", review_result.reply_text)
        self.assertIn("- 参考语义: 酥脆的", review_result.reply_text)
        self.assertIn("你刚咬下一口食物", review_result.reply_text)
        self.assertNotIn("讨论快结束时突然出现分歧", review_result.reply_text)

        session = app.session_store.get("direct:u1")
        challenge = session["review"]["current"]["challenge"]
        self.assertEqual(challenge["template_id"], "food_description")
        self.assertIn("crunchy", challenge["task"].lower())
        self.assertIn("口感", challenge["task"])

    def test_review_mode3_non_food_words_do_not_false_match_food_template(self) -> None:
        payload = {
            "word": "gigantic",
            "definitions": ["adj. 巨大的"],
            "examples": [
                {
                    "text": "From these ingredients stars arose, gigantic engines, turning simple stuff into complex stuff only to die violently and spread the new complexity around.",
                    "explanation": "恒星像巨大的引擎，把简单物质转化成更复杂的物质。",
                }
            ],
        }
        app, _client = self.make_app(payload=payload, llm_enabled=False)

        app.handle_envelope(self.make_envelope("\\mode 3"))
        app.handle_envelope(self.make_envelope("\\review"))
        session = app.session_store.get("direct:u1")
        challenge = session["review"]["current"]["challenge"]
        self.assertNotEqual(challenge["template_id"], "food_description")

    def test_review_mode1_shows_word_part_hint_for_phrasal_expression(self) -> None:
        payload = {
            "word": "gearing up",
            "definitions": ["正在准备；蓄势待发"],
            "examples": [
                {
                    "text": "Today we might very well be gearing up for a jump like our ancestors 10,000 years ago.",
                    "explanation": "这里指正在为某个重大变化做准备。",
                }
            ],
        }
        app, _client = self.make_app(payload=payload, llm_enabled=False)

        review_result = app.handle_envelope(self.make_envelope("\\review"))
        self.assertIn("**构词联想**", review_result.reply_text)
        self.assertIn("把它拆开记：`gearing` 是核心动作，`up` 常带“往上、启动、准备起来”的语感。", review_result.reply_text)

    def test_review_mode1_does_not_show_empty_memory_hint_for_generic_phrase(self) -> None:
        payload = {
            "word": "on top of that",
            "definitions": ["除此之外；另外还"],
            "examples": [
                {
                    "text": "On top of that, the delay forced us to change the entire plan.",
                    "explanation": "这里表示“除此之外”，是在前面基础上再补充一点。",
                }
            ],
        }
        app, _client = self.make_app(payload=payload, llm_enabled=False)

        review_result = app.handle_envelope(self.make_envelope("\\review"))
        self.assertNotIn("这是固定搭配，先把它按整体记，不要只盯单个词。", review_result.reply_text)
        self.assertNotIn("**构词联想**", review_result.reply_text)

    def test_review_feedback_shows_derivational_hint_when_available(self) -> None:
        payload = {
            "word": "gigantic",
            "definitions": ["adj. 巨大的（在此语境下形容恒星的规模）"],
            "examples": [
                {
                    "text": "From these ingredients stars arose, gigantic engines, turning simple stuff into complex stuff only to die violently and spread the new complexity around.",
                    "explanation": "此处 gigantic 修饰 engines（恒星），强调其体积与能量的巨大。",
                }
            ],
        }
        app, _client = self.make_app(payload=payload, llm_enabled=True)

        review_result = app.handle_envelope(self.make_envelope("\\review"))
        self.assertIn("**构词联想**", review_result.reply_text)
        self.assertIn("可以顺手连到相关词 `giant`", review_result.reply_text)

        graded_result = app.handle_envelope(self.make_envelope("巨大的"))
        self.assertIn("**构词联想**", graded_result.reply_text)
        self.assertIn("可以顺手连到相关词 `giant`", graded_result.reply_text)

    def test_review_memory_hint_prefers_llm_related_word_over_basic_suffix_rule(self) -> None:
        payload = {
            "word": "inflate",
            "definitions": ["抬高；使膨胀"],
            "examples": [
                {
                    "text": "Putting an inflated price on artifacts rather than viewing them as cultural and historical treasures that transcend any price",
                    "explanation": "这里表示给文物标上虚高的价格。",
                    "focusWords": ["inflated"],
                }
            ],
        }
        app, _client = self.make_app(payload=payload, llm_enabled=True)

        review_result = app.handle_envelope(self.make_envelope("\\review"))
        self.assertIn("**构词联想**", review_result.reply_text)
        self.assertIn("`inflation`", review_result.reply_text)
        self.assertNotIn("后缀 `-", review_result.reply_text)
        self.assertNotIn("看到 `-ing`", review_result.reply_text)

    def test_review_dirty_content_shows_diff_after_answer_and_can_be_confirmed(self) -> None:
        payload = {
            "word": "abandon",
            "definitions": ["放弃；抛弃"],
            "examples": [
                {
                    "text": "W: [6] We should abandon ship now.",
                    "explanation": "Unit of area commonly used in agriculture and land measurement.",
                }
            ],
        }
        app, client = self.make_app(payload=payload, llm_enabled=True)

        review_prompt = app.handle_envelope(self.make_envelope("\\review"))
        self.assertEqual(review_prompt.metadata.get("message_format"), "markdown")
        self.assertIn("模式 1 释义理解", review_prompt.reply_text)
        self.assertNotIn("### 清理建议", review_prompt.reply_text)

        graded_result = app.handle_envelope(self.make_envelope("这里是放弃并撤离"))
        self.assertEqual(graded_result.metadata.get("message_format"), "markdown")
        self.assertIn("### 本题反馈", graded_result.reply_text)
        self.assertIn("### 清理建议", graded_result.reply_text)
        self.assertIn("**例句 before**", graded_result.reply_text)
        self.assertIn("**例句 after**", graded_result.reply_text)
        self.assertIn("**Explanation before**", graded_result.reply_text)
        self.assertIn("**Explanation after**", graded_result.reply_text)
        self.assertEqual(len(client.save_vocab_calls), 1)

        confirm_result = app.handle_envelope(self.make_envelope("y"))
        self.assertEqual(confirm_result.metadata.get("message_format"), "markdown")
        self.assertIn("### 已保存清理", confirm_result.reply_text)
        self.assertEqual(len(client.save_vocab_calls), 2)
        saved_example = client.payload["examples"][0]
        self.assertEqual(saved_example["text"], "We should abandon ship now.")
        self.assertEqual(saved_example["explanation"], "这里表示必须立刻弃船撤离。")

    def test_review_cleanup_defaults_to_not_approved_on_other_input(self) -> None:
        payload = {
            "word": "abandon",
            "definitions": ["放弃；抛弃"],
            "examples": [
                {
                    "text": "W: [6] We should abandon ship now.",
                    "explanation": "Unit of area commonly used in agriculture and land measurement.",
                }
            ],
        }
        app, client = self.make_app(payload=payload, llm_enabled=True)

        app.handle_envelope(self.make_envelope("\\review"))
        graded_result = app.handle_envelope(self.make_envelope("这里是放弃并撤离"))
        self.assertIn("### 清理建议", graded_result.reply_text)
        self.assertEqual(len(client.save_vocab_calls), 1)

        followup_result = app.handle_envelope(self.make_envelope("继续"))
        self.assertEqual(followup_result.metadata.get("message_format"), "markdown")
        self.assertIn("### 已默认不保存清理", followup_result.reply_text)
        self.assertEqual(len(client.save_vocab_calls), 1)

    def test_review_cleanup_can_rename_word_and_file(self) -> None:
        payload = {
            "word": "tam",
            "definitions": ["vt. 驯服"],
            "examples": [
                {
                    "text": "They prayed to the stars, they tamed fire and turned stones into tools.",
                    "explanation": "",
                    "focusWords": ["tam"],
                }
            ],
            "reviewSessions": [
                {
                    "word": "tam",
                    "score": 0,
                }
            ],
        }
        app, client = self.make_app(payload=payload, llm_enabled=True)

        review_result = app.handle_envelope(self.make_envelope("\\review"))
        self.assertIn("模式 1 释义理解", review_result.reply_text)

        graded_result = app.handle_envelope(self.make_envelope("驯服"))
        self.assertIn("### 清理建议", graded_result.reply_text)
        self.assertIn("**词条 before**", graded_result.reply_text)
        self.assertIn("**词条 after**", graded_result.reply_text)
        self.assertIn("**文件 before**", graded_result.reply_text)
        self.assertIn("**文件 after**", graded_result.reply_text)
        self.assertIn("> tam", graded_result.reply_text)
        self.assertIn("> tame", graded_result.reply_text)

        confirm_result = app.handle_envelope(self.make_envelope("y"))
        self.assertEqual(confirm_result.metadata.get("message_format"), "markdown")
        self.assertIn("### 已保存清理", confirm_result.reply_text)
        self.assertIn("**tam** -> **tame**", confirm_result.reply_text)
        self.assertIn("当前没有可复习词条", confirm_result.reply_text)
        self.assertEqual(len(client.rename_vocab_calls), 1)
        self.assertEqual(client.review_item["file"], "tame.json")
        self.assertEqual(client.payload["word"], "tame")
        self.assertEqual(client.payload["examples"][0]["focusWords"], ["tame"])
        self.assertEqual(client.payload["reviewSessions"][0]["word"], "tame")
        self.assertIn("tam", client.payload["mergedFrom"])

    def test_review_cleanup_keeps_source_bound_example_wording(self) -> None:
        class RewritingCleanupLLM(FakeLLMClient):
            def chat_json(self, *, system_prompt: str, user_prompt: str, **kwargs) -> dict:
                if "英语词汇卡片清洗助手" in system_prompt:
                    return {
                        "word": "abandon",
                        "example_text": "We must leave the sinking boat right away.",
                        "explanation": "这里表示必须立刻弃船撤离。",
                        "notes": "我把句子改得更自然。",
                    }
                return super().chat_json(system_prompt=system_prompt, user_prompt=user_prompt, **kwargs)

        payload = {
            "word": "abandon",
            "definitions": ["放弃；抛弃"],
            "examples": [
                {
                    "text": "W: [6] We should abandon ship now.",
                    "explanation": "Unit of area commonly used in agriculture and land measurement.",
                    "focusWords": ["abandon"],
                    "source": {"text": "绑定来源", "url": ""},
                }
            ],
        }
        app, client = self.make_app(payload=payload, llm_enabled=True, llm_client=RewritingCleanupLLM(enabled=True))

        app.handle_envelope(self.make_envelope("\\review"))
        graded_result = app.handle_envelope(self.make_envelope("这里是放弃并撤离"))
        self.assertIn("### 清理建议", graded_result.reply_text)
        self.assertIn("> We should abandon ship now.", graded_result.reply_text)
        self.assertNotIn("leave the sinking boat", graded_result.reply_text)

        confirm_result = app.handle_envelope(self.make_envelope("y"))
        self.assertIn("### 已保存清理", confirm_result.reply_text)
        saved_example = client.payload["examples"][0]
        self.assertEqual(saved_example["text"], "We should abandon ship now.")

    def test_review_cleanup_can_normalize_inflectional_variant_to_prototype(self) -> None:
        payload = {
            "word": "lineages",
            "definitions": ["谱系；世系"],
            "examples": [
                {
                    "text": "They split into many families and lineages, evolving further or disappearing again.",
                    "explanation": "这里的 lineages 指生物演化中的谱系。",
                    "focusWords": ["lineages"],
                    "source": {"text": "Tired of Doomscrolling?", "url": ""},
                }
            ],
            "reviewSessions": [{"word": "lineages", "score": 0}],
        }
        app, client = self.make_app(payload=payload, llm_enabled=True)

        app.handle_envelope(self.make_envelope("\\review"))
        graded_result = app.handle_envelope(self.make_envelope("谱系"))
        self.assertIn("### 清理建议", graded_result.reply_text)
        self.assertIn("> lineages", graded_result.reply_text)
        self.assertIn("> lineage", graded_result.reply_text)

        confirm_result = app.handle_envelope(self.make_envelope("y"))
        self.assertIn("**lineages** -> **lineage**", confirm_result.reply_text)
        self.assertEqual(client.payload["word"], "lineage")
        self.assertEqual(client.payload["examples"][0]["focusWords"], ["lineage"])
        self.assertIn("lineages", client.payload["mergedFrom"])

    def test_review_cleanup_does_not_hallucinate_extra_e_in_word_name(self) -> None:
        payload = {
            "word": "turn",
            "definitions": ["转动；转变"],
            "examples": [
                {
                    "text": "They turned stones into tools.",
                    "explanation": "这里表示把石头变成工具。",
                    "focusWords": ["turned"],
                    "source": {"text": "绑定来源", "url": ""},
                }
            ],
        }
        app, client = self.make_app(payload=payload, llm_enabled=True)

        app.handle_envelope(self.make_envelope("\\review"))
        graded_result = app.handle_envelope(self.make_envelope("变成工具"))
        self.assertNotIn("**词条 before**", graded_result.reply_text)
        self.assertEqual(len(client.rename_vocab_calls), 0)

    def test_review_cleanup_does_not_truncate_valid_lemma_from_inflected_example(self) -> None:
        payload = {
            "word": "inflate",
            "definitions": ["抬高；使膨胀"],
            "examples": [
                {
                    "text": "Putting an inflated price on artifacts rather than viewing them as cultural and historical treasures that transcend any price",
                    "explanation": "这里表示给文物标上虚高的价格。",
                    "focusWords": ["inflated"],
                    "source": {"text": "绑定来源", "url": ""},
                }
            ],
        }
        app, client = self.make_app(payload=payload, llm_enabled=True)

        app.handle_envelope(self.make_envelope("\\review"))
        graded_result = app.handle_envelope(self.make_envelope("虚高的价格"))
        self.assertNotIn("**词条 before**", graded_result.reply_text)
        self.assertNotIn("> inflat", graded_result.reply_text)
        self.assertEqual(len(client.rename_vocab_calls), 0)


if __name__ == "__main__":
    unittest.main()

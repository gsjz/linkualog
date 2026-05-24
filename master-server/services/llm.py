import base64
import io
import json
import re
import time
import requests
from core.config import get_config_data
from core.llm_provider import resolve_chat_completions_url

try:
    from PIL import Image, ImageOps
except ImportError:
    Image = None
    ImageOps = None

try:
    from pillow_heif import register_heif_opener
except ImportError:
    register_heif_opener = None

if register_heif_opener is not None:
    register_heif_opener()


def _clean_llm_json_text(content: str) -> str:
    return content.replace("```json", "").replace("```", "").strip()


def _parse_llm_json_reply(content: str):
    clean = _clean_llm_json_text(content)
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        start = clean.find("{")
        end = clean.rfind("}")
        if start >= 0 and end > start:
            return json.loads(clean[start:end + 1])
        raise


def _extract_message_content(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text_parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text_parts.append(item.get("text", ""))
        return "".join(text_parts).strip()
    return str(content or "").strip()


def _normalize_ratio(value):
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None

    if numeric < 0:
        return None
    if numeric <= 1:
        return numeric
    if numeric <= 100:
        return numeric / 100.0
    if numeric <= 1000:
        return numeric / 1000.0
    return None


def _normalize_bbox(raw_bbox):
    if not isinstance(raw_bbox, dict):
        return None

    left = _normalize_ratio(raw_bbox.get("l", raw_bbox.get("left", raw_bbox.get("x"))))
    top = _normalize_ratio(raw_bbox.get("t", raw_bbox.get("top", raw_bbox.get("y"))))
    width = _normalize_ratio(raw_bbox.get("w", raw_bbox.get("width")))
    height = _normalize_ratio(raw_bbox.get("h", raw_bbox.get("height")))

    if None in (left, top, width, height):
        return None
    if width <= 0 or height <= 0:
        return None

    return {
        "left": max(0.0, min(1.0, left)),
        "top": max(0.0, min(1.0, top)),
        "width": max(0.0, min(1.0, width)),
        "height": max(0.0, min(1.0, height)),
    }


def _restore_marked_item(item):
    if not isinstance(item, dict):
        return None

    restored = {
        "word": item.get("word", item.get("w", "")),
        "context": item.get("context", item.get("c", "")),
    }

    raw_bbox = item.get("bbox", item.get("b", item.get("coordinates")))
    bbox = _normalize_bbox(raw_bbox)
    if bbox:
        restored["bbox"] = bbox

    return restored


def _restore_image_result(parsed_reply):
    if not isinstance(parsed_reply, dict):
        raise ValueError("LLM 返回不是 JSON 对象")

    extracted_text = parsed_reply.get("extracted_text", parsed_reply.get("t", ""))
    raw_marked_text = parsed_reply.get("marked_text", parsed_reply.get("m", []))

    marked_text = []
    if isinstance(raw_marked_text, list):
        for item in raw_marked_text:
            restored_item = _restore_marked_item(item)
            if restored_item:
                marked_text.append(restored_item)

    return {
        "extracted_text": extracted_text if isinstance(extracted_text, str) else str(extracted_text),
        "marked_text": marked_text,
    }


def _parse_image_reply(llm_reply: str):
    parsed_reply = json.loads(llm_reply)
    return _restore_image_result(parsed_reply)


def _build_image_prompt(experimental_coordinates: bool) -> str:
    prompt_prefix = (
        "你是一个专业的 OCR 和语言处理引擎。"
        "请先按阅读顺序提取这张图片中的主要文字，再找出其中那些被用户后加笔迹明确下划线标记的英文生词或重点词。"
        "不要把印刷体自带下划线、超链接样式、普通横线、表格线、标题强调线误判成用户标记。"
        "如果同一行里有多个词，只返回真正被下划线覆盖的词；不要把整行、整句或相邻单词一起塞进 word。"
        "先根据可见字母确定被标记的精确词边界，再返回 word；word 必须与图中可见字母完全一致，不要额外带上前后词、词尾标点或多余词缀。"
        "对每个词返回的 context 必须是语义完整且信息充分的上下文，优先返回完整句子；"
        "如果该词依赖前后句才能准确理解，请补充必要的前后句，不要只截取零碎短语。"
        "必须严格以 JSON 格式输出，不要包含任何额外的 markdown 标记或解释说明。"
    )

    if experimental_coordinates:
        return (
            prompt_prefix
            + "为了减少 token 和提升稳定性，所有 JSON 键名必须使用单字符简写，我们会在本地还原完整键名。"
            + "JSON 结构："
            + '{ "t": "带换行的提取文字...", "m": [ { "w": "用笔迹划出的词...", "c": "词所在的语义完整句子...", "b": { "l": 0.12, "t": 0.34, "w": 0.08, "h": 0.02 } } ] }'
            + "其中 t=extracted_text，m=marked_text，w=word，c=context，b=bbox。"
            + "bbox 内 l=left，t=top，w=width，h=height，均是相对整张图片的归一化小数，范围 0 到 1。"
            + "定位规则：先从 OCR 文本中锁定具体 token，再回到图片里估算该 token 的唯一视觉位置。"
            + "b 必须尽量紧贴被标记词本身，优先框住单词字母主体，可包含少量下划线，但不要覆盖整行、整句、相邻单词或大块留白。"
            + "如果手写下划线比单词更长，bbox 仍然要按字母主体宽度收缩，不能按整条下划线长度取框。"
            + "bbox 的宽度只应覆盖该词字母与极少左右余量；bbox 的高度应接近当前文本行高，不要把上一行、下一行或大片空白带进去。"
            + "如果相邻单词挨得很近，bbox 也只能落在被标记词自身，不要把前后单词一起框住。"
            + "如果图片有倾斜、透视或拍照畸变，请先在脑中校正后再估算归一化坐标。"
            + "如果同一个词在图中出现多次，只返回真正被划线的那一次坐标。"
            + "如果字母模糊、被遮挡、与相邻词粘连、下划线起止不清，或者你无法把框稳定压缩到单词本身，就把 b 设为 null。"
            + "如果能识别到下划线词但无法可靠定位坐标，保留该词条并将 b 设为 null。"
            + "宁可少报，也不要输出明显偏大、偏移、或覆盖多个词的错误框。"
        )

    return (
        prompt_prefix
        + 'JSON 结构：{ "extracted_text": "带换行的提取文字...", "marked_text": [ { "word": "用笔迹划出的词...", "context": "词所在的语义完整句子..." } ] }'
    )

def test_llm_connection(api_url: str, api_key: str, model_name: str) -> bool:
    """
    发送极短的提示词测试 LLM 的连通性和配置有效性。
    """
    print("正在进行 LLM 连通性测试...")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": model_name,
        "max_tokens": 10,
        "temperature": 0.1,
        "messages": [
            {
                "role": "user",
                "content": "ping（这是一个连通性测试，请只回复 'pong'）"
            }
        ]
    }

    request_url = resolve_chat_completions_url(api_url)

    try:
        response = requests.post(request_url, headers=headers, json=payload, timeout=10)
        response.raise_for_status()
        
        print("✅ LLM 连通性测试通过！")
        return True
    except Exception as e:
        print(f"❌ LLM 连通性测试失败: {e}")
        return False


def optimize_image(image_bytes: bytes, max_size: int = 2000) -> bytes:
    """
    针对 iPhone 照片的优化：转换格式、纠正旋转、缩放尺寸
    """
    if Image is None or ImageOps is None:
        raise RuntimeError("Pillow 未安装，当前环境将直接使用原始图片")

    img = Image.open(io.BytesIO(image_bytes))
    img = ImageOps.exif_transpose(img)

    if img.mode in ("RGBA", "P", "CMYK"):
        img = img.convert("RGB")

    if max(img.size) > max_size:
        img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)

    output = io.BytesIO()
    img.save(output, format="JPEG", quality=85)
    return output.getvalue()


def process_image(image_bytes: bytes, filename: str, content_type: str, experimental_coordinates: bool = True) -> dict:
    """调用 LLM 处理图片，返回原始文本和本地还原后的 JSON"""
    config = get_config_data()
    api_key = config.get("api_key")
    
    if not api_key:
        raise ValueError("未找到 API Key，请先配置")

    api_url = config.get("provider")
    request_url = resolve_chat_completions_url(api_url)
    model_name = config.get("model")

    if not test_llm_connection(api_url, api_key, model_name):
        print("⚠️ LLM 连通性测试未通过，将继续执行图片解析正式请求。")

    print(f"收到图片: {filename}, 准备进行预处理...")

    try:
        processed_bytes = optimize_image(image_bytes)
        image_mime = "image/jpeg"
    except Exception as e:
        print(f"⚠️ 图片预处理失败，尝试直接发送原图: {e}")
        processed_bytes = image_bytes
        image_mime = content_type or "image/jpeg"

    print("图片预处理完成")

    base64_image = base64.b64encode(processed_bytes).decode('utf-8')

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": model_name,
        "max_tokens": 2048 * 4, 
        "temperature": 0.2,
        "top_p": 0.5,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": _build_image_prompt(experimental_coordinates)
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{image_mime};base64,{base64_image}"
                        }
                    }
                ]
            }
        ]
    }

    max_retries = 3
    for attempt in range(max_retries):
        try:
            response = requests.post(request_url, headers=headers, json=payload, timeout=120)
            response.raise_for_status()
            
            result_data = response.json()
            llm_reply = _extract_message_content(result_data['choices'][0]['message']['content'])
            llm_reply = _clean_llm_json_text(llm_reply)
            parsed_reply = _parse_image_reply(llm_reply)
            
            print(f"✅ LLM 返回结果成功 ({filename})")
            return {
                "raw": llm_reply,
                "parsed": parsed_reply,
                "meta": {
                    "experimental_coordinates": experimental_coordinates
                }
            }
            
        except Exception as e:
            print(f"⚠️ 第 {attempt + 1} 次正式请求失败: {e}")
            if attempt < max_retries - 1:
                time.sleep(2) 
            else:
                raise Exception(f"请求大模型处理图片失败: {e}")


def process_word_definition(word: str) -> dict:
    """
    单独请求单词的通用释义
    """
    import json as standard_json
    config = get_config_data()
    api_key = config.get("api_key")
    api_url = config.get("provider")
    request_url = resolve_chat_completions_url(api_url)
    model_name = config.get("model")

    if not api_key: raise ValueError("未找到 API Key，请先配置")

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    
    prompt = (
        "你是一个专业的英文词典 API 引擎。\n"
        f"请为英文生词 '{word}' 提供全面的中文释义数组。\n"
        "每条 definitions 都必须以中文释义为主，可以保留极短的词性或英文提示，但不能输出纯英文释义。\n"
        "优先给出适合中国学习者直接记忆和复习的表达，不要写成冗长段落。\n"
        "必须严格以纯 JSON 格式输出，不要包含 markdown 代码块或其他说明文字。\n"
        "JSON 结构示例：\n"
        "{\n"
        '  "definitions": [\n'
        '    "vt. 放弃，抛弃（计划、信念等）",\n'
        '    "vt. 离弃，遗弃（人、物或地方）"\n'
        '  ]\n'
        "}"
    )

    payload = {
        "model": model_name, "max_tokens": 1024, "temperature": 0.1,
        "messages": [{"role": "system", "content": "你是一个严格的 JSON 响应机器。"}, {"role": "user", "content": prompt}]
    }

    print(f"🔄 正在向 LLM 请求基础释义: {word}")
    for attempt in range(3):
        try:
            response = requests.post(request_url, headers=headers, json=payload, timeout=30)
            response.raise_for_status()
            llm_reply = _extract_message_content(response.json()['choices'][0]['message']['content'])
            llm_reply = _clean_llm_json_text(llm_reply)
            return standard_json.loads(llm_reply)
        except Exception as e:
            if attempt == 2: raise Exception(f"请求大模型处理基础释义失败: {e}")
            time.sleep(1)


def process_context_analysis(word: str, context: str) -> dict:
    """
    专门调用 LLM 进行特定语境下的例句解析、语境释义生成，并严格对齐标准 Schema。
    """
    import json as standard_json
    config = get_config_data()
    api_key = config.get("api_key")
    api_url = config.get("provider")
    request_url = resolve_chat_completions_url(api_url)
    model_name = config.get("model")

    if not api_key: raise ValueError("未找到 API Key，请先配置")

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    
    prompt = (
        "你是一个专业的英文翻译和词典 API 引擎。\n"
        f"请根据生词 '{word}' 及其出现的上下文句子 '{context}'，生成：\n"
        "1. 该词在这句话中具体、贴切的中文释义（将其作为字符串放入 definitions 数组中；释义必须以中文为主，可补一个极短英文提示，但不能是纯英文）\n"
        "2. 将该上下文句子作为例句对象放入 examples 数组中，并提供精准、自然、完整的中文 explanation；该 explanation 既要体现整句意思，也要点明该词在句中的中文含义。\n"
        "3. focusWords 必须只放真正需要聚焦的词，默认就是该生词本身或最小必要词组。\n"
        "必须严格以纯 JSON 格式输出，不要包含 Markdown 代码块标记（如 ```json）。\n"
        "JSON 结构示例：\n"
        "{\n"
        '  "definitions": ["vt. 放弃 (在此语境下的释义)"],\n'
        '  "examples": [\n'
        '    {\n'
        f'      "text": "{context}",\n'
        '      "explanation": "船长下达了弃船的命令。",\n'
        f'      "focusWords": ["{word}"]\n'
        '    }\n'
        '  ]\n'
        "}"
    )

    payload = {
        "model": model_name, "max_tokens": 1024, "temperature": 0.1,
        "messages": [{"role": "system", "content": "你是一个严格的 JSON 响应机器。"}, {"role": "user", "content": prompt}]
    }

    print(f"🔄 正在向 LLM 请求例句解析: {word}")
    for attempt in range(3):
        try:
            response = requests.post(request_url, headers=headers, json=payload, timeout=30)
            response.raise_for_status()
            llm_reply = _extract_message_content(response.json()['choices'][0]['message']['content'])
            llm_reply = _clean_llm_json_text(llm_reply)
            return standard_json.loads(llm_reply)
        except Exception as e:
            if attempt == 2: raise Exception(f"请求大模型处理例句解析失败: {e}")
            time.sleep(1)


def _clean_task_name_suggestion(value) -> str:
    cleaned = re.sub(r"\s+", " ", str(value or "")).strip()
    cleaned = cleaned.strip("\"'“”‘’`")
    cleaned = re.sub(r"[\r\n\t]+", " ", cleaned).strip()
    return cleaned[:80]


_CET_BASE_RE = re.compile(
    r"\b(CET\s*6|CET6|六级)\s*(?:20)?(\d{2})\s*(\d{1,2})\s*(\d+)\b",
    flags=re.IGNORECASE,
)
_CET6_SIGNAL_RE = re.compile(r"\bCET\s*6\b|CET6|六级", flags=re.IGNORECASE)
_CET_ONLY_SIGNAL_RE = re.compile(r"\bCET\b(?!\s*[46])", flags=re.IGNORECASE)
_QUESTION_NUMBER_RE = re.compile(r"\b([1-5]\d)\s*[.．]")
_PASSAGE_RE = re.compile(r"\bPassage\s+(One|Two|Three|Four|1|2|3|4)\b", flags=re.IGNORECASE)
_ROMAN_PASSAGE_MAP = {"one": 1, "two": 2, "three": 3, "four": 4}
_TASK_SOURCE_STOPWORDS = {
    "cet",
    "cet6",
    "c",
    "阅读",
    "匹配",
    "听力",
    "翻译",
    "选词",
    "填空",
    "长篇",
}


def _normalize_cet_base(subject: str) -> str | None:
    match = _CET_BASE_RE.search(subject or "")
    if not match:
        return None
    exam = "CET6"
    year = str(int(match.group(2)))
    month = str(int(match.group(3)))
    set_no = str(int(match.group(4)))
    return f"{exam} {year} {month} {set_no}"


def _infer_cet_reading_suffix(context: str) -> str:
    text = str(context or "")
    if not text.strip():
        return ""

    passage_numbers = []
    for match in _PASSAGE_RE.finditer(text):
        raw = match.group(1).lower()
        passage_numbers.append(int(raw) if raw.isdigit() else _ROMAN_PASSAGE_MAP.get(raw, 0))
    passage_numbers = sorted({num for num in passage_numbers if num > 0})

    question_numbers = sorted({int(item) for item in _QUESTION_NUMBER_RE.findall(text)})
    has_46_50 = any(46 <= num <= 50 for num in question_numbers)
    has_51_55 = any(51 <= num <= 55 for num in question_numbers)

    if 2 in passage_numbers and 1 not in passage_numbers:
        return "阅读2"
    if 1 in passage_numbers and 2 in passage_numbers:
        return "阅读1-2"
    if has_51_55 and not has_46_50:
        return "阅读2"
    if has_46_50 and not has_51_55:
        return "阅读1"
    if has_46_50 and has_51_55:
        return "阅读1-2"
    return ""


def _build_task_name_context_hints(subject: str, context: str) -> dict:
    base = _normalize_cet_base(subject)
    suffix = _infer_cet_reading_suffix(context)
    hints = {
        "subject_is_blank": not str(subject or "").strip(),
        "normalized_base": base or "",
        "suggested_suffix_from_local_clues": suffix,
        "visible_edge_or_key_clues": [],
        "negative_clues": [],
    }
    if "Passage Two" in context or "Passage 2" in context:
        hints["visible_edge_or_key_clues"].append("正文边角/标题位置出现 Passage Two")
    if re.search(r"Questions\s+51\s+to\s+55", context, flags=re.IGNORECASE):
        hints["visible_edge_or_key_clues"].append("关键说明出现 Questions 51 to 55")
    question_numbers = sorted({int(item) for item in _QUESTION_NUMBER_RE.findall(context or "")})
    if question_numbers:
        hints["visible_edge_or_key_clues"].append(f"可见题号范围 {question_numbers[0]}-{question_numbers[-1]}")
    if not str(subject or "").strip() and context.strip():
        hints["visible_edge_or_key_clues"].append("任务主体未填写，需要主要依靠当前任务文本和已有命名样例推断")
    if base and suffix:
        hints["negative_clues"].append("主体只缺阅读篇目信息时，不要改成匹配/长篇阅读/选词填空/翻译/听力")
    if not str(subject or "").strip() and suffix:
        hints["negative_clues"].append("主体为空时，可以从已有来源样例学习命名骨架，但年份/月/套数必须来自样例与当前文本的共同证据，不要凭空编造")
    return hints


def _tokenize_source_match_text(value: str) -> set[str]:
    return {
        item.casefold()
        for item in re.findall(r"[A-Za-z]+|\d+|[\u4e00-\u9fff]+", str(value or ""))
        if item.casefold() not in _TASK_SOURCE_STOPWORDS
    }


def _source_type_bonus(source: str, hints: dict) -> int:
    suffix = str(hints.get("suggested_suffix_from_local_clues") or "")
    if not suffix:
        return 0
    if suffix in source:
        return 8
    if "阅读" in suffix and "阅读" in source and "匹配" not in source:
        return 4
    if "匹配" in source and "阅读" in suffix:
        return -6
    return 0


def _select_task_name_source_examples(source_names: list[str], subject: str, hints: dict, limit: int = 24) -> list[str]:
    subject_tokens = _tokenize_source_match_text(subject)
    base_tokens = _tokenize_source_match_text(hints.get("normalized_base") or "")
    wanted_tokens = subject_tokens | base_tokens
    suffix = str(hints.get("suggested_suffix_from_local_clues") or "")
    if not source_names:
        return []

    scored = []
    seen = set()
    for index, source in enumerate(source_names):
        item = re.sub(r"\s+", " ", str(source or "")).strip()
        if not item:
            continue
        key = item.casefold()
        if key in seen:
            continue
        seen.add(key)
        source_tokens = _tokenize_source_match_text(item)
        overlap = len(wanted_tokens & source_tokens)
        score = (overlap * 3) + _source_type_bonus(item, hints)
        if not wanted_tokens and suffix:
            if "阅读" in suffix and "阅读" in item and "匹配" not in item:
                score += 6
            elif "匹配" in item and "阅读" in suffix:
                score -= 6
        if score <= 0 and len(scored) >= limit:
            continue
        scored.append((score, -index, item))

    scored.sort(reverse=True)
    positive = [item for score, _, item in scored if score > 0]
    fallback = [item for score, _, item in scored if score <= 0]
    return (positive + fallback)[:limit]


def _build_task_name_source_hints(prompt_sources: list[str]) -> dict:
    has_cet6 = any(_CET6_SIGNAL_RE.search(source) for source in prompt_sources)
    has_cet_only = any(_CET_ONLY_SIGNAL_RE.search(source) for source in prompt_sources)
    hints = {
        "prefer_cet6_when_cet6_evidence_exists": has_cet6,
        "has_plain_cet_examples": has_cet_only,
        "notes": [],
    }
    if has_cet6:
        hints["notes"].append("已有来源样例里出现 CET6/六级证据；如果当前文本和样例都不像 CET4/四级，推荐名里的考试前缀应优先规范成 CET6，而不是单独写 CET")
    if has_cet_only and has_cet6:
        hints["notes"].append("裸 CET 样例可能是历史命名缩写；当同组线索存在 CET6 样例时，裸 CET 不应压过 CET6")
    return hints


def recommend_task_name(subject: str = "", source_names: list[str] | None = None, context: str = "") -> dict:
    config = get_config_data()
    api_key = config.get("api_key")
    api_url = config.get("provider")
    model_name = config.get("model")

    normalized_subject = re.sub(r"\s+", " ", str(subject or "")).strip()
    context_excerpt = re.sub(r"\s+", " ", str(context or "")).strip()[:6000]
    context_hints = _build_task_name_context_hints(normalized_subject, context_excerpt)

    if not api_key:
        raise ValueError("未找到 API Key，请先配置")
    if not api_url or not model_name:
        raise ValueError("LLM provider/model 未配置")

    request_url = resolve_chat_completions_url(api_url)
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    normalized_sources = []
    seen = set()
    for source in source_names or []:
        item = re.sub(r"\s+", " ", str(source or "")).strip()
        if not item:
            continue
        key = item.casefold()
        if key in seen:
            continue
        seen.add(key)
        normalized_sources.append(item)

    prompt_sources = _select_task_name_source_examples(normalized_sources, normalized_subject, context_hints)
    source_hints = _build_task_name_source_hints(prompt_sources)
    prompt = (
        "你是 Linkualog 的学习任务命名助手。\n"
        "任务：根据用户填写的任务主体线索，并参考已有词条的来源名称列表，推荐一个最适合作为本次资源解析任务的任务名。\n"
        "要求：\n"
        "1. 如果主体线索像某个已有来源，优先沿用或轻微规范化该来源名称。\n"
        "2. 如果主体线索未填写，不要直接返回通用名；先根据当前任务文本的边角处、标题、题号、说明句、Passage 标记推理任务类型，再参考已有来源名称的命名骨架。\n"
        "3. 不要编造具体册数、页码、题号或来源编号；来源列表里已有的具体信息可以使用。\n"
        "4. 先从当前任务文本的边角处、标题、题号、说明句和 Passage 标记推理任务类型；这些位置通常比词条来源频次更可靠。\n"
        "5. 如果任务主体已经保留了试卷年份、月份、套数，只补充从当前任务文本可确定的阅读篇目，例如“阅读1”“阅读2”“阅读1-2”；如果主体为空，则可以从少量已有来源样例里推断命名格式和可能的考试前缀。\n"
        "6. 当前任务文本若出现 Passage One/Two 或 46-55 的仔细阅读题号，应优先判断为阅读任务；不要因为已有来源里有“匹配”就推荐“匹配”。\n"
        "7. “匹配/长篇阅读/选词填空/翻译/听力”等题型只有在当前任务文本明确属于该题型时才能使用。\n"
        "8. 已有来源名称只是命名风格参考，不是投票结果；如果来源样例与当前任务文本矛盾，以当前任务文本为准。\n"
        "9. 如果已有来源样例里出现 CET6/六级证据，且没有 CET4/四级证据，推荐名应优先使用 CET6，不要输出单独的 CET；裸 CET 可视为历史缩写。\n"
        "10. 任务名长度控制在 4-32 个中文字符或等量英文字符，避免标点堆叠。\n"
        "11. 只输出纯 JSON，不要包含 Markdown 或解释。\n"
        'JSON 结构：{"name":"推荐任务名","reason":"一句中文理由"}\n\n'
        f"任务主体线索: {normalized_subject or '未填写'}\n"
        f"本地预处理线索（仅供你判断，不可机械照抄）: {json.dumps(context_hints, ensure_ascii=False)}\n"
        f"已有来源前缀线索（仅供规范命名，不可机械照抄）: {json.dumps(source_hints, ensure_ascii=False)}\n"
        f"当前任务文本摘要: {context_excerpt or '未提供'}\n"
        "已有来源名称（本地已按主体相关性和题型一致性筛选去重，少量注入）：\n"
        + json.dumps(prompt_sources, ensure_ascii=False)
    )

    payload = {
        "model": model_name,
        "max_tokens": 256,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": "你是一个严格输出 JSON 的中文任务命名助手。"},
            {"role": "user", "content": prompt},
        ],
    }

    for attempt in range(3):
        try:
            response = requests.post(request_url, headers=headers, json=payload, timeout=30)
            response.raise_for_status()
            llm_reply = _extract_message_content(response.json()["choices"][0]["message"]["content"])
            parsed = _parse_llm_json_reply(llm_reply)
            if not isinstance(parsed, dict):
                raise ValueError("LLM 返回不是 JSON 对象")

            name = _clean_task_name_suggestion(parsed.get("name"))
            if not name:
                raise ValueError("LLM 未返回可用任务名")
            reason = re.sub(r"\s+", " ", str(parsed.get("reason") or "")).strip()
            return {
                "name": name,
                "reason": reason[:160],
                "source_count": len(prompt_sources),
                "source": "llm",
            }
        except Exception as e:
            if attempt == 2:
                raise Exception(f"请求大模型推荐任务名失败: {e}")
            time.sleep(1)

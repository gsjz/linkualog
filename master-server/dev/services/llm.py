import base64
import io
import json
import time
import requests
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener
from core.config import get_config_data

register_heif_opener()


def _clean_llm_json_text(content: str) -> str:
    return content.replace("```json", "").replace("```", "").strip()


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
        "请提取这张图片中的主要文字，并找出其中的英文被用户用笔做下划线标记的生词或重点词。"
        "必须严格以 JSON 格式输出，不要包含任何额外的 markdown 标记或解释说明。"
    )

    if experimental_coordinates:
        return (
            prompt_prefix
            + "这是一个实验模式。"
            + "为了减少 token 和提升稳定性，所有 JSON 键名必须使用单字符简写，我们会在本地还原完整键名。"
            + "JSON 结构："
            + '{ "t": "带换行的提取文字...", "m": [ { "w": "用笔迹划出的词...", "c": "词所在的语义完整句子...", "b": { "l": 0.12, "t": 0.34, "w": 0.08, "h": 0.02 } } ] }'
            + "其中 t=extracted_text，m=marked_text，w=word，c=context，b=bbox。"
            + "bbox 内 l=left，t=top，w=width，h=height，均是相对整张图片的归一化小数，范围 0 到 1。"
            + "如果能识别到下划线词但无法可靠定位坐标，保留该词条并将 b 设为 null。"
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

    try:
        response = requests.post(api_url, headers=headers, json=payload, timeout=10)
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
    img = Image.open(io.BytesIO(image_bytes))
    img = ImageOps.exif_transpose(img)

    if img.mode in ("RGBA", "P", "CMYK"):
        img = img.convert("RGB")

    if max(img.size) > max_size:
        img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)

    output = io.BytesIO()
    img.save(output, format="JPEG", quality=85)
    return output.getvalue()


def process_image(image_bytes: bytes, filename: str, content_type: str, experimental_coordinates: bool = False) -> dict:
    """调用 LLM 处理图片，返回原始文本和本地还原后的 JSON"""
    config = get_config_data()
    api_key = config.get("api_key")
    
    if not api_key:
        raise ValueError("未找到 API Key，请先配置")

    api_url = config.get("provider")
    model_name = config.get("model")

    if not test_llm_connection(api_url, api_key, model_name):
        raise ConnectionError("LLM 连通性测试未通过，请检查网络、API 地址或 API Key 是否正确。")

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
        "temperature": 0.1,
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
            response = requests.post(api_url, headers=headers, json=payload, timeout=120)
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
    单独请求单词的基础音标和通用释义
    """
    import json as standard_json
    config = get_config_data()
    api_key = config.get("api_key")
    api_url = config.get("provider")
    model_name = config.get("model")

    if not api_key: raise ValueError("未找到 API Key，请先配置")

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    
    prompt = (
        "你是一个专业的英文词典 API 引擎。\n"
        f"请为英文生词 '{word}' 提供全面的中文释义数组。\n"
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
            response = requests.post(api_url, headers=headers, json=payload, timeout=30)
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
    model_name = config.get("model")

    if not api_key: raise ValueError("未找到 API Key，请先配置")

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    
    prompt = (
        "你是一个专业的英文翻译和词典 API 引擎。\n"
        f"请根据生词 '{word}' 及其出现的上下文句子 '{context}'，生成：\n"
        "1. 该词在这句话中具体、贴切的中文释义（将其作为字符串放入 definitions 数组中）\n"
        "2. 将该上下文句子作为例句对象放入 examples 数组中，并提供精准的中文翻译 (explanation) 和焦点词 (focusWords)。\n"
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
            response = requests.post(api_url, headers=headers, json=payload, timeout=30)
            response.raise_for_status()
            llm_reply = _extract_message_content(response.json()['choices'][0]['message']['content'])
            llm_reply = _clean_llm_json_text(llm_reply)
            return standard_json.loads(llm_reply)
        except Exception as e:
            if attempt == 2: raise Exception(f"请求大模型处理例句解析失败: {e}")
            time.sleep(1)

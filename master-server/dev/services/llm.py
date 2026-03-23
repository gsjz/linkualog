import base64
import requests
import time
from core.config import get_config_data

def process_image(image_bytes: bytes, filename: str, content_type: str) -> str:
    """调用 LLM 处理图片，返回 JSON 字符串结果（带重试机制）"""
    config = get_config_data()
    api_key = config.get("api_key")
    
    if not api_key:
        raise ValueError("未找到 API Key，请先配置")

    api_url = config.get("provider")
    model_name = config.get("model")

    print(f"收到图片: {filename}, 准备请求模型: {model_name}")

    base64_image = base64.b64encode(image_bytes).decode('utf-8')
    image_mime = content_type or "image/jpeg"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": model_name,
        "max_tokens": 2048 * 8,
        "temperature": 0.1,
        "top_p": 0.5,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "你是一个专业的 OCR 和语言处理引擎。"
                            "请提取这张图片中的主要文字，并找出其中的英文被用户用笔做下划线标记的生词或重点词。"
                            "必须严格以 JSON 格式输出，不要包含任何额外的 markdown 标记或解释说明。"
                            "请严格按照以下 JSON 结构输出：\n"
                            "{\n"
                            '  "extracted_text": "完整的原文段落",\n'
                            '  "marked_text": [\n'
                            '    {\n'
                            '      "word": "被用户用笔做下划线标记的生词或重点词",\n'
                            '      "context": "该词在原文中的完整上下文句子"\n'
                            '    }\n'
                            '  ]\n'
                            "}"
                        ) 
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
            response = requests.post(api_url, headers=headers, json=payload, timeout=300)
            response.raise_for_status()
            
            result_data = response.json()
            llm_reply = result_data['choices'][0]['message']['content']
            print(f"✅ LLM 返回结果成功 ({filename})\n{llm_reply}")
            return llm_reply
            
        except requests.exceptions.RequestException as e:
            print(f"⚠️ 第 {attempt + 1} 次请求 LLM 失败: {e}")
            if attempt < max_retries - 1:
                time.sleep(2) 
            else:
                raise Exception(f"请求大模型接口失败(已重试{max_retries}次): {e}")
        except (KeyError, IndexError) as e:
            raise Exception(f"大模型返回数据格式异常，无法解析: {e}。原始返回: {response.text}")
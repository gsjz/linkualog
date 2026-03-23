import os
import json

CONFIG_FILE = "local_data/llm_config.json"
DEFAULT_PROVIDER = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
DEFAULT_MODEL = "qwen3.5-27b"

def get_config_data():
    """读取并返回配置"""
    if not os.path.exists(CONFIG_FILE):
        return {"provider": DEFAULT_PROVIDER, "model": DEFAULT_MODEL, "hasKey": False, "api_key": ""}
    
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        config = json.load(f)
        
    return {
        "provider": config.get("provider", DEFAULT_PROVIDER),
        "model": config.get("model", DEFAULT_MODEL),
        "hasKey": bool(config.get("api_key")),
        "api_key": config.get("api_key", "")
    }

def save_config_data(provider: str, model: str, api_key: str = ""):
    """保存配置到文件"""
    config = {}
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            config = json.load(f)
            
    config["provider"] = provider
    config["model"] = model
    
    if api_key.strip():
        config["api_key"] = api_key.strip()
        
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
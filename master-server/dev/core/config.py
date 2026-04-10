import os
import json

CONFIG_FILE = os.environ.get("CONFIG_FILE")
DEFAULT_PROVIDER = os.environ.get("DEFAULT_PROVIDER")
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL")

def get_config_data():
    """读取并返回配置"""
    if not os.path.exists(CONFIG_FILE):
        return {
            "provider": DEFAULT_PROVIDER,
            "model": DEFAULT_MODEL,
            "hasKey": False,
            "api_key": "",
            "experimental_coordinates_enabled": False
        }
    
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        config = json.load(f)
        
    return {
        "provider": config.get("provider", DEFAULT_PROVIDER),
        "model": config.get("model", DEFAULT_MODEL),
        "hasKey": bool(config.get("api_key")),
        "api_key": config.get("api_key", ""),
        "experimental_coordinates_enabled": bool(config.get("experimental_coordinates_enabled", False))
    }

def save_config_data(
    provider: str,
    model: str,
    api_key: str = "",
    experimental_coordinates_enabled: bool | None = None
):
    """保存配置到文件"""
    config = {}
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            config = json.load(f)
            
    config["provider"] = provider
    config["model"] = model
    
    if api_key.strip():
        config["api_key"] = api_key.strip()

    if experimental_coordinates_enabled is not None:
        config["experimental_coordinates_enabled"] = bool(experimental_coordinates_enabled)
    
    os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
    
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)

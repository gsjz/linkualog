import json
import os

CONFIG_FILE = os.environ.get("AGENT_CONFIG", "local_data/agent_config.json")
DEFAULT_PROVIDER = os.environ.get("DEFAULT_PROVIDER", "")
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL", "")
DEFAULT_API_KEY = os.environ.get("DEFAULT_API_KEY", "")


def get_config_data() -> dict:
    if not os.path.exists(CONFIG_FILE):
        return {
            "provider": DEFAULT_PROVIDER,
            "model": DEFAULT_MODEL,
            "hasKey": bool(DEFAULT_API_KEY),
            "api_key": DEFAULT_API_KEY,
        }

    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        config = json.load(f)

    api_key = config.get("api_key", DEFAULT_API_KEY)
    return {
        "provider": config.get("provider", DEFAULT_PROVIDER),
        "model": config.get("model", DEFAULT_MODEL),
        "hasKey": bool(api_key),
        "api_key": api_key,
    }


def save_config_data(provider: str, model: str, api_key: str = "") -> None:
    config = {}
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            config = json.load(f)

    config["provider"] = provider.strip()
    config["model"] = model.strip()

    if api_key.strip():
        config["api_key"] = api_key.strip()

    config_dir = os.path.dirname(CONFIG_FILE)
    if config_dir:
        os.makedirs(config_dir, exist_ok=True)

    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)

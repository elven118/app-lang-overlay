from __future__ import annotations

import json
from pathlib import Path


def profile_path(game: str) -> Path:
    return Path("data") / "profiles" / f"{game}.json"


def runtime_config_path() -> Path:
    return Path("config") / "runtime.json"


def load_runtime_llm_config() -> dict:
    path = runtime_config_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    llm = data.get("llm")
    return llm if isinstance(llm, dict) else {}


def load_runtime_overlay_config() -> dict:
    path = runtime_config_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    overlay = data.get("overlay")
    return overlay if isinstance(overlay, dict) else {}


def try_load_capture_region(game: str) -> dict | None:
    p = profile_path(game)
    if not p.exists():
        return None

    profile = json.loads(p.read_text(encoding="utf-8"))
    region = profile.get("capture_region")
    if not isinstance(region, dict):
        return None

    for key in ("left", "top", "width", "height"):
        if key not in region:
            return None

    width = int(region["width"])
    height = int(region["height"])
    if width <= 0 or height <= 0:
        return None

    return {
        "left": int(region["left"]),
        "top": int(region["top"]),
        "width": width,
        "height": height,
    }


def get_ocr_lang(game: str, default_lang: str = "en") -> str:
    p = profile_path(game)
    if p.exists():
        try:
            profile = json.loads(p.read_text(encoding="utf-8"))
            overlay_settings = profile.get("overlay_settings")
            if isinstance(overlay_settings, dict):
                value = str(overlay_settings.get("ocrLang", "")).strip()
                if value:
                    return value
        except Exception:
            pass

    overlay_cfg = load_runtime_overlay_config()
    value = str(overlay_cfg.get("ocr_lang", "")).strip()
    if value:
        return value
    return default_lang


def get_overlay_auto_hide_ms(game: str, default_ms: int = -1) -> int:
    p = profile_path(game)
    if p.exists():
        try:
            profile = json.loads(p.read_text(encoding="utf-8"))
            overlay_settings = profile.get("overlay_settings")
            if isinstance(overlay_settings, dict):
                value = int(overlay_settings.get("autoHideMs", default_ms))
                return value
        except Exception:
            pass

    overlay_cfg = load_runtime_overlay_config()
    value = overlay_cfg.get("auto_hide_ms")
    if value is None:
        return default_ms
    try:
        return int(value)
    except Exception:
        return default_ms

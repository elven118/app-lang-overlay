from __future__ import annotations

import json
import os
from dataclasses import dataclass

from .paths import PROJECT_ROOT


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    return default if raw in (None, "") else int(raw)


def _bool_env(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw in (None, ""):
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _runtime_llm_config() -> dict[str, object]:
    path = PROJECT_ROOT / "config" / "runtime.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    llm = value.get("llm") if isinstance(value, dict) else None
    return llm if isinstance(llm, dict) else {}


@dataclass(frozen=True, slots=True)
class BackendSettings:
    host: str = "127.0.0.1"
    port: int = 8765
    api_token: str = ""
    allow_insecure_lan: bool = False
    translator_mode: str = "local"
    remote_translation_url: str = ""
    remote_translation_token: str = ""
    model_path: str = ""
    max_image_bytes: int = 4 * 1024 * 1024
    max_header_bytes: int = 64 * 1024
    max_blocks: int = 100
    max_source_chars: int = 16_000

    @classmethod
    def from_env(cls, **overrides: object) -> "BackendSettings":
        llm = _runtime_llm_config()
        values: dict[str, object] = {
            "host": os.getenv("OVERLAY_BACKEND_HOST") or "127.0.0.1",
            "port": _int_env("OVERLAY_BACKEND_PORT", 8765),
            "api_token": os.getenv("OVERLAY_BACKEND_API_TOKEN", ""),
            "allow_insecure_lan": _bool_env("OVERLAY_ALLOW_INSECURE_LAN"),
            "translator_mode": (
                os.getenv("OVERLAY_LLM_MODE")
                or str(llm.get("mode") or "local")
            ).strip().lower(),
            "remote_translation_url": (
                os.getenv("OVERLAY_LLM_REMOTE_URL")
                or str(llm.get("remote_url") or "")
            ),
            "remote_translation_token": (
                os.getenv("OVERLAY_LLM_REMOTE_API_KEY")
                or str(llm.get("remote_api_key") or "")
            ),
            "model_path": (
                os.getenv("OVERLAY_LLM_MODEL_PATH")
                or str(llm.get("model_path") or "")
            ),
        }
        values.update({key: value for key, value in overrides.items() if value is not None})
        settings = cls(**values)
        settings.validate()
        return settings

    def validate(self) -> None:
        if not 1 <= self.port <= 65535:
            raise ValueError("backend port must be in range 1...65535")
        loopback = self.host in {"127.0.0.1", "localhost", "::1"}
        if not loopback and not self.api_token:
            raise ValueError("OVERLAY_BACKEND_API_TOKEN is required when binding beyond loopback")
        if not loopback and not self.allow_insecure_lan:
            raise ValueError("OVERLAY_ALLOW_INSECURE_LAN=1 is required for a non-loopback ws:// listener")
        if self.translator_mode not in {"local", "remote"}:
            raise ValueError("OVERLAY_LLM_MODE must be local or remote")
        if self.translator_mode == "remote" and not self.remote_translation_url:
            raise ValueError("remote translation URL is required in remote mode")

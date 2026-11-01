from __future__ import annotations

from pathlib import Path

from ..config import BackendSettings, PROJECT_ROOT
from .common import TranslationProvider
from .groq_provider import GroqProvider
from .local_llama_provider import LocalLlamaProvider
from .remote_http_provider import RemoteHttpProvider


def build_translation_provider(settings: BackendSettings) -> TranslationProvider:
    if settings.translator_mode == "groq":
        settings.validate()
        return GroqProvider(settings.groq_api_key, settings.groq_model)
    if settings.translator_mode == "remote":
        return RemoteHttpProvider(settings.remote_translation_url, settings.remote_translation_token)
    candidate = Path(settings.model_path).expanduser()
    if not candidate.is_absolute():
        candidate = PROJECT_ROOT / candidate
    return LocalLlamaProvider(str(candidate))

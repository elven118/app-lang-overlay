from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from threading import Lock
from typing import Protocol
from urllib import request

from ..config import BackendSettings, PROJECT_ROOT
from ..domain import ProtocolError, TextBlock
from .language_mapping import target_language_name


class TranslationProvider(Protocol):
    revision: str

    async def translate_blocks(
        self,
        blocks: list[TextBlock],
        source_language: str,
        target_language: str,
    ) -> dict[str, str]: ...


class TranslationAlignmentError(ProtocolError):
    def __init__(self) -> None:
        super().__init__(
            "translation_alignment_failed",
            "Translator must return one non-empty translation for every source block ID",
            retryable=True,
        )


def validate_translations(value: object, blocks: list[TextBlock]) -> dict[str, str]:
    expected = {block.id for block in blocks}
    if (len(expected) != len(blocks) or not isinstance(value, dict) or set(value) != expected
            or any(not isinstance(text, str) or not text.strip() for text in value.values())):
        raise TranslationAlignmentError()
    return {identifier: text.strip() for identifier, text in value.items()}


def _translation_text(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TranslationAlignmentError()
    return value.strip()


def _prompt(text: str, source_language: str, target_language: str) -> str:
    target_language = target_language_name(target_language)
    return (
        "You are a translator.\n"
        f"Translate from {source_language} to {target_language}.\n"
        "Return only the translated text, without reasoning, markdown or commentary.\n"
        f"Input:\n{text}\n"
        "Output:"
    )


class LocalLlamaProvider:
    def __init__(self, model_path: str) -> None:
        path = Path(model_path).expanduser()
        self._model_path = path if path.is_absolute() else PROJECT_ROOT / path
        self.revision = f"llama-per-block-v3:{self._model_path.name}"
        self._llm = None
        self._lock = Lock()

    def _load(self) -> object:
        if self._llm is not None:
            return self._llm
        if not self._model_path.is_file():
            raise RuntimeError(f"Local LLM model not found: {self._model_path}")
        from llama_cpp import Llama

        self._llm = Llama(
            model_path=str(self._model_path),
            n_gpu_layers=int(os.getenv("OVERLAY_LLM_N_GPU_LAYERS", "-1")),
            n_ctx=int(os.getenv("OVERLAY_LLM_N_CTX", "4096")),
            n_threads=int(os.getenv("OVERLAY_LLM_N_THREADS", str(max(os.cpu_count() or 4, 4)))),
            n_batch=int(os.getenv("OVERLAY_LLM_N_BATCH", "1024")),
            chat_format=os.getenv("OVERLAY_LLM_CHAT_FORMAT") or None,
            verbose=False,
        )
        return self._llm

    def _translate_sync(self, blocks: list[TextBlock], source_language: str, target_language: str) -> dict[str, str]:
        translations: dict[str, str] = {}
        for block in blocks:
            # IDs stay in backend code. The model sees one block's text only.
            # Serialize access to the shared llama.cpp context across sessions.
            with self._lock:
                output = self._load()(
                    _prompt(block.text, source_language, target_language),
                    max_tokens=int(os.getenv("OVERLAY_LLM_MAX_TOKENS", "1024")),
                    temperature=0.1,
                )
            try:
                choice = output["choices"][0]
                if choice.get("finish_reason") == "length":
                    raise TranslationAlignmentError()
                translated = choice["text"]
            except (TypeError, KeyError, IndexError):
                raise TranslationAlignmentError() from None
            translations[block.id] = _translation_text(translated)
        return validate_translations(translations, blocks)

    async def translate_blocks(self, blocks: list[TextBlock], source_language: str, target_language: str) -> dict[str, str]:
        return await asyncio.to_thread(self._translate_sync, blocks, source_language, target_language)


class RemoteHttpProvider:
    def __init__(self, url: str, token: str = "") -> None:
        self._url = url
        self._token = token
        self.revision = f"remote-http-per-block-v3:{url}"

    def _translate_sync(self, blocks: list[TextBlock], source_language: str, target_language: str) -> dict[str, str]:
        translations = {
            block.id: self._translate_text(block.text, source_language, target_language)
            for block in blocks
        }
        return validate_translations(translations, blocks)

    def _translate_text(self, text: str, source_language: str, target_language: str) -> str:
        payload = json.dumps(
            {
                "text": text,
                "source_lang": source_language,
                "target_lang": target_language,
            },
            ensure_ascii=False,
        ).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        req = request.Request(self._url, data=payload, headers=headers, method="POST")
        with request.urlopen(req, timeout=20) as response:
            try:
                body = json.loads(response.read().decode("utf-8"))
            except (ValueError, UnicodeError):
                raise TranslationAlignmentError() from None
        if not isinstance(body, dict):
            raise TranslationAlignmentError()
        return _translation_text(body.get("translated_text") or body.get("translatedText") or body.get("text"))

    async def translate_blocks(self, blocks: list[TextBlock], source_language: str, target_language: str) -> dict[str, str]:
        return await asyncio.to_thread(self._translate_sync, blocks, source_language, target_language)


def build_translation_provider(settings: BackendSettings) -> TranslationProvider:
    if settings.translator_mode == "remote":
        return RemoteHttpProvider(settings.remote_translation_url, settings.remote_translation_token)
    candidate = Path(settings.model_path).expanduser()
    if not candidate.is_absolute():
        candidate = PROJECT_ROOT / candidate
    return LocalLlamaProvider(str(candidate))

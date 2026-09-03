from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Protocol
from urllib import request

from ..config import BackendSettings, PROJECT_ROOT
from ..domain import TextBlock


class TranslationProvider(Protocol):
    revision: str

    async def translate_blocks(
        self,
        blocks: list[TextBlock],
        source_language: str,
        target_language: str,
    ) -> dict[str, str]: ...


def _prompt(blocks: list[TextBlock], source_language: str, target_language: str) -> str:
    source = [{"id": item.id, "text": item.text} for item in blocks]
    return (
        "Translate every item while using the complete array as context. "
        "Preserve each id and return only a JSON array containing id and translatedText. "
        f"Source language: {source_language}. Target language: {target_language}.\n"
        f"Input: {json.dumps(source, ensure_ascii=False)}\nOutput:"
    )


def _parse_aligned(body: object, blocks: list[TextBlock]) -> dict[str, str] | None:
    if isinstance(body, dict):
        body = body.get("blocks") or body.get("translations")
    if not isinstance(body, list):
        return None
    expected = {item.id for item in blocks}
    parsed: dict[str, str] = {}
    for item in body:
        if not isinstance(item, dict):
            return None
        item_id = str(item.get("id") or "")
        translated = str(item.get("translatedText") or item.get("translated_text") or "").strip()
        if item_id not in expected or not translated or item_id in parsed:
            return None
        parsed[item_id] = translated
    return parsed if set(parsed) == expected else None


class LocalLlamaProvider:
    def __init__(self, model_path: str) -> None:
        path = Path(model_path).expanduser()
        self._model_path = path if path.is_absolute() else PROJECT_ROOT / path
        self.revision = f"llama:{self._model_path.name}"
        self._llm = None

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
        output = self._load()(
            _prompt(blocks, source_language, target_language),
            max_tokens=int(os.getenv("OVERLAY_LLM_MAX_TOKENS", "1024")),
            temperature=0.1,
        )
        raw = str(output["choices"][0]["text"]).strip()
        try:
            aligned = _parse_aligned(json.loads(raw), blocks)
        except json.JSONDecodeError:
            aligned = None
        return aligned if aligned is not None else ({"__combined__": raw} if raw and blocks else {})

    async def translate_blocks(self, blocks: list[TextBlock], source_language: str, target_language: str) -> dict[str, str]:
        return await asyncio.to_thread(self._translate_sync, blocks, source_language, target_language)


class RemoteHttpProvider:
    def __init__(self, url: str, token: str = "") -> None:
        self._url = url
        self._token = token
        self.revision = f"remote-http-v1:{url}"

    def _translate_sync(self, blocks: list[TextBlock], source_language: str, target_language: str) -> dict[str, str]:
        payload = json.dumps(
            {
                "sourceLanguage": source_language,
                "targetLanguage": target_language,
                "blocks": [{"id": item.id, "text": item.text} for item in blocks],
                "prompt": _prompt(blocks, source_language, target_language),
            },
            ensure_ascii=False,
        ).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        req = request.Request(self._url, data=payload, headers=headers, method="POST")
        with request.urlopen(req, timeout=20) as response:
            body = json.loads(response.read().decode("utf-8"))
        aligned = _parse_aligned(body, blocks)
        if aligned is not None:
            return aligned
        combined = str(body.get("translatedText") or body.get("translated_text") or "").strip() if isinstance(body, dict) else ""
        if blocks and combined:
            return {"__combined__": combined}
        raise RuntimeError("Remote translator returned no usable translation")

    async def translate_blocks(self, blocks: list[TextBlock], source_language: str, target_language: str) -> dict[str, str]:
        return await asyncio.to_thread(self._translate_sync, blocks, source_language, target_language)


def build_translation_provider(settings: BackendSettings) -> TranslationProvider:
    if settings.translator_mode == "remote":
        return RemoteHttpProvider(settings.remote_translation_url, settings.remote_translation_token)
    candidate = Path(settings.model_path).expanduser()
    if not candidate.is_absolute():
        candidate = PROJECT_ROOT / candidate
    return LocalLlamaProvider(str(candidate))

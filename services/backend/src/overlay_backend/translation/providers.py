from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Protocol
from urllib import request

from ..config import BackendSettings, PROJECT_ROOT
from ..domain import TextBlock
from .language_mapping import target_language_name


class TranslationProvider(Protocol):
    revision: str

    async def translate_blocks(
        self,
        blocks: list[TextBlock],
        source_language: str,
        target_language: str,
    ) -> dict[str, str]: ...


def _prompt(blocks: list[TextBlock], source_language: str, target_language: str) -> str:
    source_text = "\n".join(item.text.strip() for item in blocks if item.text.strip())
    target_language = target_language_name(target_language)
    return (
        "You are a translator.\n"
        f"Translate from {source_language} to {target_language}.\n"
        "Return only the translated text.\n"
        f"Input:\n{source_text}\n"
        "Output:"
    )


class LocalLlamaProvider:
    def __init__(self, model_path: str) -> None:
        path = Path(model_path).expanduser()
        self._model_path = path if path.is_absolute() else PROJECT_ROOT / path
        self.revision = f"llama-blocks-v1:{self._model_path.name}"
        self._llm = None
        self._block_cache: OrderedDict[tuple[str, str, str], str] = OrderedDict()
        # One native Llama context is shared by all region/session workers.
        # Hold this lock in the worker thread: cancelling asyncio.to_thread()
        # does not stop native inference, so an asyncio lock alone is unsafe.
        self._inference_lock = threading.Lock()

    def _load(self) -> object:
        if self._llm is not None:
            return self._llm
        if not self._model_path.is_file():
            raise RuntimeError(f"Local LLM model not found: {self._model_path}")
        from llama_cpp import Llama, llama_cpp

        gpu_layers = int(os.getenv("OVERLAY_LLM_N_GPU_LAYERS", "-1"))
        gpu_supported = llama_cpp.llama_supports_gpu_offload()
        if gpu_layers != 0 and not gpu_supported:
            logging.getLogger(__name__).warning(
                "GPU layers requested, but llama-cpp-python was built without GPU offload support. "
                "Local translation will run on CPU; install a CUDA build on NVIDIA Windows/Linux "
                "or a Metal build on Apple Silicon."
            )

        self._llm = Llama(
            model_path=str(self._model_path),
            n_gpu_layers=gpu_layers,
            n_ctx=int(os.getenv("OVERLAY_LLM_N_CTX", "4096")),
            n_threads=int(os.getenv("OVERLAY_LLM_N_THREADS", str(max(os.cpu_count() or 4, 4)))),
            n_batch=int(os.getenv("OVERLAY_LLM_N_BATCH", "1024")),
            chat_format=os.getenv("OVERLAY_LLM_CHAT_FORMAT") or None,
            verbose=False,
        )
        return self._llm

    def _translate_sync(self, blocks: list[TextBlock], source_language: str, target_language: str) -> dict[str, str]:
        translated_by_id: dict[str, str] = {}
        for block in blocks:
            text = block.text.strip()
            if not text:
                translated_by_id[block.id] = ""
                continue
            key = (source_language, target_language, text)
            with self._inference_lock:
                translated = self._block_cache.get(key)
                if translated is None:
                    output = self._load()(
                        _prompt([block], source_language, target_language),
                        max_tokens=int(os.getenv("OVERLAY_LLM_MAX_TOKENS", "1024")),
                        temperature=0.1,
                    )
                    translated = str(output["choices"][0]["text"]).strip()
                    if not translated:
                        raise RuntimeError("Translator returned an empty translation")
                    self._block_cache[key] = translated
                    while len(self._block_cache) > 512:
                        self._block_cache.popitem(last=False)
                self._block_cache.move_to_end(key)
            translated_by_id[block.id] = translated
        return translated_by_id

    async def translate_blocks(self, blocks: list[TextBlock], source_language: str, target_language: str) -> dict[str, str]:
        return await asyncio.to_thread(self._translate_sync, blocks, source_language, target_language)


class RemoteHttpProvider:
    def __init__(self, url: str, token: str = "") -> None:
        self._url = url
        self._token = token
        self.revision = f"remote-http-blocks-v1:{url}"

    def _translate_sync(self, blocks: list[TextBlock], source_language: str, target_language: str) -> dict[str, str]:
        return {block.id: self._translate_text(block.text.strip(), source_language, target_language)
                if block.text.strip() else "" for block in blocks}

    def _translate_text(self, source_text: str, source_language: str, target_language: str) -> str:
        payload = json.dumps(
            {
                "text": source_text,
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
            body = json.loads(response.read().decode("utf-8"))
        translated = (
            str(body.get("translated_text") or body.get("translatedText") or body.get("text") or "").strip()
            if isinstance(body, dict)
            else ""
        )
        if translated:
            return translated
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

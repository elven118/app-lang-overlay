from __future__ import annotations

import asyncio
import logging
import os
from collections import OrderedDict
from pathlib import Path
from threading import Lock

from ..config import PROJECT_ROOT
from ..domain import TextBlock
from .common import TranslationAlignmentError, _prompt, _translation_text, validate_translations


class LocalLlamaProvider:
    def __init__(self, model_path: str) -> None:
        path = Path(model_path).expanduser()
        self._model_path = path if path.is_absolute() else PROJECT_ROOT / path
        self.revision = f"llama-per-block-v3:{self._model_path.name}"
        self._llm = None
        # Keep the native context locked in the worker thread, even if its
        # asyncio caller is cancelled while inference is still running.
        self._lock = Lock()
        self._block_cache: OrderedDict[tuple[str, str, str], str] = OrderedDict()

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
        translations: dict[str, str] = {}
        for block in blocks:
            text = block.text.strip()
            key = (source_language, target_language, text)
            with self._lock:
                translated = self._block_cache.get(key)
                if translated is None:
                    output = self._load()(
                        _prompt(text, source_language, target_language),
                        max_tokens=int(os.getenv("OVERLAY_LLM_MAX_TOKENS", "1024")),
                        temperature=0.1,
                    )
                    try:
                        choice = output["choices"][0]
                        if choice.get("finish_reason") == "length":
                            raise TranslationAlignmentError()
                        translated = _translation_text(choice["text"])
                    except (TypeError, KeyError, IndexError, AttributeError):
                        raise TranslationAlignmentError() from None
                    self._block_cache[key] = translated
                    while len(self._block_cache) > 512:
                        self._block_cache.popitem(last=False)
                self._block_cache.move_to_end(key)
            translations[block.id] = translated
        return validate_translations(translations, blocks)

    async def translate_blocks(self, blocks: list[TextBlock], source_language: str, target_language: str) -> dict[str, str]:
        return await asyncio.to_thread(self._translate_sync, blocks, source_language, target_language)

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from .config import load_runtime_llm_config


class LocalTranslator:
    def __init__(self, target_lang: str = "繁體中文") -> None:
        self.target_lang = target_lang
        self._llm = None
        self._enabled = False
        self._max_tokens = 128
        self._load()

    def _load(self) -> None:
        cfg = load_runtime_llm_config()
        model_path = str(cfg.get("model_path") or "").strip()
        if not model_path:
            print("[overlay-backend] translator disabled: llm.model_path missing")
            return
        if not Path(model_path).exists():
            print(f"[overlay-backend] translator disabled: model not found: {model_path}")
            return

        self._max_tokens = int(cfg.get("max_tokens", 128))
        n_gpu_layers = int(cfg.get("n_gpu_layers", -1))
        n_ctx = int(cfg.get("n_ctx", 2048))
        n_threads = int(cfg.get("n_threads", max(os.cpu_count() or 4, 4)))
        n_batch = int(cfg.get("n_batch", 512))
        chat_format = cfg.get("chat_format") or None

        try:
            from llama_cpp import Llama
        except Exception:
            print("[overlay-backend] translator disabled: llama_cpp not installed")
            return

        try:
            self._llm = Llama(
                model_path=model_path,
                n_gpu_layers=n_gpu_layers,
                n_ctx=n_ctx,
                n_threads=n_threads,
                n_batch=n_batch,
                chat_format=chat_format,
                verbose=False,
            )
            self._enabled = True
            print(f"[overlay-backend] translator enabled model={model_path}")
        except Exception as exc:
            print(f"[overlay-backend] translator disabled: load failed: {exc}")

    def _translate_sync(self, source_text: str) -> str:
        if not source_text:
            return ""
        if not self._enabled or self._llm is None:
            return source_text

        prompt = (
            "You are a subtitle translator.\n"
            f"Translate to {self.target_lang}.\n"
            "Return only translated text in one line.\n"
            f"Input: {source_text}\n"
            "Output:"
        )
        try:
            out = self._llm(prompt, max_tokens=self._max_tokens, temperature=0.1)
            text = out["choices"][0]["text"].strip()
            return text or source_text
        except Exception as exc:
            print(f"[overlay-backend] translator inference failed: {exc}")
            return source_text

    async def translate(self, source_text: str) -> str:
        return await asyncio.to_thread(self._translate_sync, source_text)

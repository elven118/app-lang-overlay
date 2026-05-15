from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from urllib import error, request

from .config import load_runtime_llm_config


class LocalTranslator:
    def __init__(self, target_lang: str = "Chinese") -> None:
        self.target_lang = target_lang
        self._llm = None
        self._enabled = False
        self._max_tokens = 128
        self._mode = "local"
        self._remote_url = ""
        self._remote_timeout_s = 20
        self._remote_api_key = ""
        self._load()

    def _load(self) -> None:
        cfg = load_runtime_llm_config()
        self._mode = str(os.getenv("OVERLAY_LLM_MODE") or cfg.get("mode") or "local").strip().lower()

        self._max_tokens = int(cfg.get("max_tokens", 128))

        if self._mode == "remote":
            self._remote_url = str(
                os.getenv("OVERLAY_LLM_REMOTE_URL")
                or cfg.get("remote_url")
                or ""
            ).strip()
            self._remote_api_key = str(
                os.getenv("OVERLAY_LLM_REMOTE_API_KEY")
                or cfg.get("remote_api_key")
                or ""
            ).strip()
            self._remote_timeout_s = int(
                os.getenv("OVERLAY_LLM_REMOTE_TIMEOUT_S")
                or cfg.get("remote_timeout_s")
                or 20
            )

            if not self._remote_url:
                print("[overlay-backend] translator disabled: llm.remote_url missing in remote mode")
                return

            self._enabled = True
            print(f"[overlay-backend] translator enabled mode=remote url={self._remote_url}")
            return

        model_path = str(cfg.get("model_path") or "").strip()
        if not model_path:
            print("[overlay-backend] translator disabled: llm.model_path missing")
            return
        if not Path(model_path).exists():
            print(f"[overlay-backend] translator disabled: model not found: {model_path}")
            return

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
            print(f"[overlay-backend] translator enabled mode=local model={model_path}")
        except Exception as exc:
            print(f"[overlay-backend] translator disabled: load failed: {exc}")

    def _prompt(self, source_text: str) -> str:
        return (
            "You are a subtitle translator.\n"
            f"Translate to {self.target_lang}.\n"
            "Return only translated text in one line.\n"
            f"Input: {source_text}\n"
            "Output:"
        )

    def _translate_remote_sync(self, source_text: str) -> str:
        if not source_text:
            return ""

        payload = {
            "text": source_text,
            "target_lang": self.target_lang,
            "max_tokens": self._max_tokens,
            "prompt": self._prompt(source_text),
        }
        data = json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self._remote_api_key:
            headers["Authorization"] = f"Bearer {self._remote_api_key}"

        req = request.Request(self._remote_url, data=data, headers=headers, method="POST")
        try:
            with request.urlopen(req, timeout=self._remote_timeout_s) as resp:
                body = resp.read().decode("utf-8", errors="replace")
        except error.HTTPError as exc:
            print(f"[overlay-backend] remote translator http error: {exc.code}")
            return source_text
        except Exception as exc:
            print(f"[overlay-backend] remote translator request failed: {exc}")
            return source_text

        try:
            obj = json.loads(body)
        except Exception:
            print("[overlay-backend] remote translator invalid json response")
            return source_text

        translated = str(obj.get("translated_text") or obj.get("text") or "").strip()
        return translated or source_text

    def _translate_local_sync(self, source_text: str) -> str:
        if not source_text:
            return ""
        if self._llm is None:
            return source_text

        prompt = self._prompt(source_text)
        try:
            out = self._llm(prompt, max_tokens=self._max_tokens, temperature=0.1)
            text = out["choices"][0]["text"].strip()
            return text or source_text
        except Exception as exc:
            print(f"[overlay-backend] translator inference failed: {exc}")
            return source_text

    def _translate_sync(self, source_text: str) -> str:
        if not self._enabled:
            return source_text
        if self._mode == "remote":
            return self._translate_remote_sync(source_text)
        return self._translate_local_sync(source_text)

    async def translate(self, source_text: str) -> str:
        return await asyncio.to_thread(self._translate_sync, source_text)

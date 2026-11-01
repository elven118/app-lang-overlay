from __future__ import annotations

import asyncio
import json
from urllib import request

from ..domain import TextBlock
from .common import TranslationAlignmentError, _translation_text, validate_translations


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

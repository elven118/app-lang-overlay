from __future__ import annotations

import asyncio
import os

from ..domain import TextBlock
from .common import TranslationAlignmentError, _prompt, _translation_text, validate_translations


class GroqProvider:
    def __init__(self, api_key: str, model: str = "llama-3.3-70b-versatile") -> None:
        from groq import Groq

        self._client = Groq(api_key=api_key, timeout=20.0, max_retries=0)
        self._model = model
        self.revision = f"groq-per-block-v1:{model}"

    def _translate_sync(self, blocks: list[TextBlock], source_language: str, target_language: str) -> dict[str, str]:
        translations: dict[str, str] = {}
        for block in blocks:
            output = self._client.chat.completions.create(
                model=self._model,
                messages=[{"role": "user", "content": _prompt(block.text, source_language, target_language)}],
                max_completion_tokens=int(os.getenv("OVERLAY_LLM_MAX_TOKENS", "1024")),
                temperature=0.1,
            )
            try:
                choice = output.choices[0]
                if choice.finish_reason != "stop":
                    raise TranslationAlignmentError()
                translations[block.id] = _translation_text(choice.message.content)
            except (TypeError, IndexError, AttributeError):
                raise TranslationAlignmentError() from None
        return validate_translations(translations, blocks)

    async def translate_blocks(self, blocks: list[TextBlock], source_language: str, target_language: str) -> dict[str, str]:
        return await asyncio.to_thread(self._translate_sync, blocks, source_language, target_language)

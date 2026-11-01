from __future__ import annotations

from typing import Protocol

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

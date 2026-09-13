from __future__ import annotations

import unittest

from overlay_backend.domain import NormalizedBounds, TextBlock
from overlay_backend.translation.providers import LocalLlamaProvider, _prompt


def block(identifier: str, text: str) -> TextBlock:
    return TextBlock(identifier, text, 0.9, NormalizedBounds(0.1, 0.1, 0.5, 0.1), 0)


class _RecordingLlama:
    def __init__(self, translated_text: str) -> None:
        self.translated_text = translated_text
        self.prompt = ""

    def __call__(self, prompt: str, **_: object) -> dict[str, object]:
        self.prompt = prompt
        return {"choices": [{"text": self.translated_text}]}


class TranslationProviderTests(unittest.TestCase):
    def test_prompt_sends_ocr_content_as_plain_text(self) -> None:
        blocks = [block("block-0", "Review details"), block("block-1", "Changes requested")]

        prompt = _prompt(blocks, "en", "zh-Hant")

        self.assertIn("Input:\nReview details\nChanges requested\nOutput:", prompt)
        self.assertNotIn("block-0", prompt)
        self.assertNotIn("translatedText", prompt)

    def test_local_provider_uses_complete_response_as_translation(self) -> None:
        llama = _RecordingLlama("審核詳情\n需要修改")
        provider = LocalLlamaProvider("unused.gguf")
        provider._llm = llama
        blocks = [block("block-0", "Review details"), block("block-1", "Changes requested")]

        translated = provider._translate_sync(blocks, "en", "zh-Hant")

        self.assertEqual(translated, {"__combined__": "審核詳情\n需要修改"})
        self.assertIn("Review details\nChanges requested", llama.prompt)

    def test_empty_blocks_do_not_call_model(self) -> None:
        llama = _RecordingLlama("must not be used")
        provider = LocalLlamaProvider("unused.gguf")
        provider._llm = llama

        self.assertEqual(provider._translate_sync([], "en", "zh-Hant"), {})
        self.assertEqual(llama.prompt, "")


if __name__ == "__main__":
    unittest.main()

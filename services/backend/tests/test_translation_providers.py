from __future__ import annotations

import json
import unittest
from unittest.mock import MagicMock, patch

from overlay_backend.domain import NormalizedBounds, TextBlock
from overlay_backend.translation.providers import (
    LocalLlamaProvider, RemoteHttpProvider, TranslationAlignmentError, _prompt,
)


def block(identifier: str, text: str) -> TextBlock:
    return TextBlock(identifier, text, 0.9, NormalizedBounds(0.1, 0.1, 0.5, 0.1), 0)


class TranslationProviderTests(unittest.TestCase):
    def test_prompt_contains_only_one_source_text_without_block_metadata(self) -> None:
        prompt = _prompt("Review details", "en", "zh-Hant")
        self.assertIn("Input:\nReview details\nOutput:", prompt)
        self.assertIn("Return only the translated text", prompt)
        self.assertNotIn("JSON", prompt)
        self.assertNotIn("block", prompt)

    def test_local_provider_calls_model_once_per_block_and_assigns_ids_in_code(self) -> None:
        llama = MagicMock(side_effect=[
            {"choices": [{"text": " 審核詳情 "}]},
            {"choices": [{"text": "需要修改"}]},
        ])
        provider = LocalLlamaProvider("unused.gguf")
        provider._llm = llama
        blocks = [block("block-0", "Review details"), block("block-1", "Changes requested")]

        self.assertEqual(provider._translate_sync(blocks, "en", "zh-Hant"), {
            "block-0": "審核詳情", "block-1": "需要修改",
        })
        self.assertEqual(llama.call_count, 2)
        first, second = llama.call_args_list
        self.assertIn("Review details", first.args[0])
        self.assertNotIn("Changes requested", first.args[0])
        self.assertIn("Changes requested", second.args[0])
        self.assertNotIn("Review details", second.args[0])
        for call in llama.call_args_list:
            self.assertNotIn("block-0", call.args[0])
            self.assertNotIn("block-1", call.args[0])
            self.assertNotIn("grammar", call.kwargs)

    def test_empty_non_string_or_truncated_response_rejects_whole_frame(self) -> None:
        for choice in [{"text": " "}, {"text": None}, {"text": 42}, {"text": "partial", "finish_reason": "length"}]:
            with self.subTest(choice=choice):
                provider = LocalLlamaProvider("unused.gguf")
                provider._llm = MagicMock(side_effect=[
                    {"choices": [{"text": "First succeeds"}]}, {"choices": [choice]},
                ])
                with self.assertRaises(TranslationAlignmentError):
                    provider._translate_sync([block("a", "One"), block("b", "Two")], "en", "ja")

    def test_remote_provider_sends_one_text_request_per_block(self) -> None:
        responses = []
        for text in ["一", "二"]:
            response = MagicMock()
            response.__enter__.return_value.read.return_value = json.dumps({"translated_text": text}).encode()
            responses.append(response)
        with patch('overlay_backend.translation.providers.request.urlopen', side_effect=responses) as http:
            translations = RemoteHttpProvider('https://translator.test', 'secret')._translate_sync(
                [block("a", "One"), block("b", "Two")], "en", "zh-Hant",
            )
        self.assertEqual(translations, {"a": "一", "b": "二"})
        self.assertEqual(http.call_count, 2)
        self.assertEqual([json.loads(call.args[0].data) for call in http.call_args_list], [
            {"text": "One", "source_lang": "en", "target_lang": "zh-Hant"},
            {"text": "Two", "source_lang": "en", "target_lang": "zh-Hant"},
        ])
        for call in http.call_args_list:
            self.assertEqual(call.args[0].get_header('Authorization'), 'Bearer secret')

    def test_remote_provider_rejects_empty_non_string_and_block_array_responses(self) -> None:
        for body in [{"translated_text": " "}, {"translated_text": 42}, {"blocks": []}, []]:
            with self.subTest(body=body), patch('overlay_backend.translation.providers.request.urlopen') as http:
                http.return_value.__enter__.return_value.read.return_value = json.dumps(body).encode()
                with self.assertRaises(TranslationAlignmentError):
                    RemoteHttpProvider('https://translator.test')._translate_sync([block("a", "One")], "en", "ja")

    def test_empty_blocks_call_neither_model_nor_http(self) -> None:
        provider = LocalLlamaProvider("unused.gguf")
        provider._llm = MagicMock()
        self.assertEqual(provider._translate_sync([], "en", "zh-Hant"), {})
        provider._llm.assert_not_called()
        with patch('overlay_backend.translation.providers.request.urlopen') as http:
            self.assertEqual(RemoteHttpProvider('https://translator.test')._translate_sync([], "en", "ja"), {})
            http.assert_not_called()


if __name__ == "__main__":
    unittest.main()

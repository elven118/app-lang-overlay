from __future__ import annotations

import asyncio
import concurrent.futures
import tempfile
import threading
import time
from types import SimpleNamespace
import json
import unittest
from unittest.mock import MagicMock, patch

from overlay_backend.domain import NormalizedBounds, TextBlock
from overlay_backend.config import BackendSettings
from overlay_backend.translation.common import TranslationAlignmentError, _prompt
from overlay_backend.translation.groq_provider import GroqProvider
from overlay_backend.translation.local_llama_provider import LocalLlamaProvider
from overlay_backend.translation.provider_selector import build_translation_provider
from overlay_backend.translation.remote_http_provider import RemoteHttpProvider


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
        with patch('overlay_backend.translation.remote_http_provider.request.urlopen', side_effect=responses) as http:
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
            with self.subTest(body=body), patch('overlay_backend.translation.remote_http_provider.request.urlopen') as http:
                http.return_value.__enter__.return_value.read.return_value = json.dumps(body).encode()
                with self.assertRaises(TranslationAlignmentError):
                    RemoteHttpProvider('https://translator.test')._translate_sync([block("a", "One")], "en", "ja")

    def test_empty_blocks_call_neither_model_nor_http(self) -> None:
        provider = LocalLlamaProvider("unused.gguf")
        provider._llm = MagicMock()
        self.assertEqual(provider._translate_sync([], "en", "zh-Hant"), {})
        provider._llm.assert_not_called()
        with patch('overlay_backend.translation.remote_http_provider.request.urlopen') as http:
            self.assertEqual(RemoteHttpProvider('https://translator.test')._translate_sync([], "en", "ja"), {})
            http.assert_not_called()


class GroqProviderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.groq = MagicMock()
        self.module_patch = patch.dict("sys.modules", {"groq": SimpleNamespace(Groq=self.groq)})
        self.module_patch.start()
        self.addCleanup(self.module_patch.stop)
        self.create = self.groq.return_value.chat.completions.create

    def completion(self, content: object, finish_reason: str = "stop") -> SimpleNamespace:
        return SimpleNamespace(choices=[SimpleNamespace(
            finish_reason=finish_reason, message=SimpleNamespace(content=content),
        )])

    def test_groq_uses_configured_model_and_maps_each_block(self) -> None:
        with patch.dict("os.environ", {
            "OVERLAY_LLM_MODE": "groq", "GROQ_API_KEY": "test-key",
            "OVERLAY_LLM_GROQ_MODEL": "custom-model", "OVERLAY_LLM_MAX_TOKENS": "256",
        }, clear=True):
            provider = build_translation_provider(BackendSettings.from_env())
            self.create.side_effect = [self.completion(" First translation "), self.completion("Second translation")]
            result = asyncio.run(provider.translate_blocks([block("a", "One"), block("b", "Two")], "en", "zh-Hant"))
        self.assertIsInstance(provider, GroqProvider)
        self.assertEqual(result, {"a": "First translation", "b": "Second translation"})
        self.groq.assert_called_once_with(api_key="test-key", timeout=20.0, max_retries=0)
        self.assertEqual(self.create.call_count, 2)
        for call, text in zip(self.create.call_args_list, ["One", "Two"]):
            self.assertEqual(call.kwargs["model"], "custom-model")
            self.assertEqual(call.kwargs["max_completion_tokens"], 256)
            self.assertEqual(call.kwargs["messages"], [{"role": "user", "content": _prompt(text, "en", "zh-Hant")}])
        self.assertIn("custom-model", provider.revision)
        self.assertNotIn("test-key", provider.revision)

    def test_groq_rejects_invalid_or_incomplete_responses(self) -> None:
        responses = [
            self.completion(" "), self.completion(None), self.completion(42),
            self.completion("partial", "length"), self.completion("blocked", "content_filter"),
            SimpleNamespace(choices=[]), SimpleNamespace(choices=[None]), None,
        ]
        provider = GroqProvider("test-key")
        for response in responses:
            with self.subTest(response=response):
                self.create.side_effect = [self.completion("First succeeds"), response]
                with self.assertRaises(TranslationAlignmentError):
                    provider._translate_sync([block("a", "One"), block("b", "Two")], "en", "ja")

    def test_groq_empty_blocks_do_not_request_completion(self) -> None:
        self.assertEqual(GroqProvider("test-key")._translate_sync([], "en", "ja"), {})
        self.create.assert_not_called()

    def test_groq_api_errors_propagate(self) -> None:
        self.create.side_effect = RuntimeError("API unavailable")
        with self.assertRaisesRegex(RuntimeError, "API unavailable"):
            GroqProvider("test-key")._translate_sync([block("a", "One")], "en", "ja")

    def test_groq_settings_require_key_only_in_groq_mode(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(BackendSettings.from_env().translator_mode, "local")
            with self.assertRaisesRegex(ValueError, "GROQ_API_KEY"):
                BackendSettings.from_env(translator_mode="groq")
            settings = BackendSettings.from_env(translator_mode="groq", groq_api_key="test-key")
            self.assertEqual(settings.groq_model, "llama-3.3-70b-versatile")
            with self.assertRaisesRegex(ValueError, "OVERLAY_LLM_GROQ_MODEL"):
                BackendSettings.from_env(translator_mode="groq", groq_api_key="test-key", groq_model=" ")
            self.assertIsInstance(build_translation_provider(BackendSettings()), LocalLlamaProvider)
            self.assertIsInstance(build_translation_provider(BackendSettings(
                translator_mode="remote", remote_translation_url="https://translator.test",
            )), RemoteHttpProvider)


class _RecordingLlama:
    def __init__(self, translated_text: str) -> None:
        self.translated_text = translated_text
        self.prompt = ""
        self.prompts: list[str] = []

    def __call__(self, prompt: str, **_: object) -> dict[str, object]:
        self.prompt = prompt
        self.prompts.append(prompt)
        return {"choices": [{"text": self.translated_text}]}

class TranslationCacheAndConcurrencyTests(unittest.TestCase):
    def test_parallel_regions_load_one_model_and_never_overlap_inference(self) -> None:
        active = 0
        peak_active = 0
        loads = 0
        state_lock = threading.Lock()
        barrier = threading.Barrier(4)

        class FakeLlama:
            def __init__(self, **kwargs: object) -> None:
                nonlocal loads
                with state_lock:
                    loads += 1
                time.sleep(0.02)

            def __call__(self, prompt: str, **kwargs: object) -> dict[str, object]:
                nonlocal active, peak_active
                with state_lock:
                    active += 1
                    peak_active = max(peak_active, active)
                try:
                    time.sleep(0.02)
                    return {"choices": [{"text": "translated"}]}
                finally:
                    with state_lock:
                        active -= 1

        fake_module = SimpleNamespace(Llama=FakeLlama, llama_cpp=SimpleNamespace(llama_supports_gpu_offload=lambda: True))
        with tempfile.NamedTemporaryFile(suffix=".gguf") as model, patch.dict("sys.modules", {"llama_cpp": fake_module}):
            provider = LocalLlamaProvider(model.name)

            def translate(index: int) -> dict[str, str]:
                barrier.wait(timeout=3)
                return provider._translate_sync([block(str(index), f"Region {index}")], "en", "zh-Hant")

            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
                results = list(executor.map(translate, range(4)))
        self.assertEqual(loads, 1)
        self.assertEqual(peak_active, 1)
        self.assertEqual(results, [{str(index): "translated"} for index in range(4)])

    def test_local_block_cache_remaps_ids_and_includes_both_languages(self) -> None:
        llama = _RecordingLlama("translated")
        provider = LocalLlamaProvider("unused.gguf")
        provider._llm = llama
        provider._translate_sync([block("old", "Same text")], "en", "zh-Hant")
        result = provider._translate_sync([block("new", "Same text")], "en", "zh-Hant")
        self.assertEqual(result, {"new": "translated"})
        self.assertEqual(len(llama.prompts), 1)
        provider._translate_sync([block("new", "Same text")], "en", "ja")
        provider._translate_sync([block("new", "Same text")], "auto", "ja")
        self.assertEqual(len(llama.prompts), 3)

    def test_remote_provider_maps_each_plain_text_response_to_its_block_id(self) -> None:
        payloads = []

        class Response:
            def __init__(self, req):
                self.payload = json.loads(req.data)
                payloads.append(self.payload)

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def read(self):
                return json.dumps({"translated_text": f"translated:{self.payload['text']}"}).encode()

        with patch("overlay_backend.translation.remote_http_provider.request.urlopen", side_effect=lambda req, timeout: Response(req)):
            result = RemoteHttpProvider("https://example.test/translate")._translate_sync(
                [block("a", "First"), block("b", "Second")], "en", "zh-Hant",
            )
        self.assertEqual(result, {"a": "translated:First", "b": "translated:Second"})
        self.assertEqual([payload["text"] for payload in payloads], ["First", "Second"])

class TranslationCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_region_keeps_native_context_locked_until_inference_finishes(self) -> None:
        entered = threading.Event()
        release = threading.Event()
        second_entered = threading.Event()
        calls = 0

        class BlockingLlama:
            def __call__(self, prompt: str, **kwargs: object) -> dict[str, object]:
                nonlocal calls
                calls += 1
                if calls == 1:
                    entered.set()
                    if not release.wait(timeout=5):
                        raise RuntimeError("Test did not release inference")
                else:
                    second_entered.set()
                return {"choices": [{"text": "translated"}]}

        provider = LocalLlamaProvider("unused.gguf")
        provider._llm = BlockingLlama()
        first = asyncio.create_task(provider.translate_blocks([block("a", "Old region")], "en", "zh-Hant"))
        second = None
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 2))
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            second = asyncio.create_task(provider.translate_blocks([block("b", "New region")], "en", "zh-Hant"))
            self.assertFalse(await asyncio.to_thread(second_entered.wait, 0.1))
            release.set()
            self.assertEqual(await asyncio.wait_for(second, 3), {"b": "translated"})
            self.assertTrue(second_entered.is_set())
        finally:
            release.set()
            await asyncio.gather(first, *([second] if second is not None else []), return_exceptions=True)


if __name__ == "__main__":
    unittest.main()

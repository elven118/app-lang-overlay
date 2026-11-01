from __future__ import annotations

import unittest
import asyncio
import concurrent.futures
import tempfile
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch

from overlay_backend.domain import NormalizedBounds, TextBlock
from overlay_backend.translation.providers import LocalLlamaProvider, RemoteHttpProvider, _prompt
import json


def block(identifier: str, text: str) -> TextBlock:
    return TextBlock(identifier, text, 0.9, NormalizedBounds(0.1, 0.1, 0.5, 0.1), 0)


class _RecordingLlama:
    def __init__(self, translated_text: str) -> None:
        self.translated_text = translated_text
        self.prompt = ""
        self.prompts: list[str] = []

    def __call__(self, prompt: str, **_: object) -> dict[str, object]:
        self.prompt = prompt
        self.prompts.append(prompt)
        return {"choices": [{"text": self.translated_text}]}


class TranslationProviderTests(unittest.TestCase):
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

    def test_prompt_sends_ocr_content_as_plain_text(self) -> None:
        blocks = [block("block-0", "Review details"), block("block-1", "Changes requested")]

        prompt = _prompt(blocks, "en", "zh-Hant")

        self.assertIn("Input:\nReview details\nChanges requested\nOutput:", prompt)
        self.assertNotIn("block-0", prompt)
        self.assertNotIn("translatedText", prompt)

    def test_local_provider_preserves_each_block_id_and_complete_response(self) -> None:
        llama = _RecordingLlama("審核詳情\n需要修改")
        provider = LocalLlamaProvider("unused.gguf")
        provider._llm = llama
        blocks = [block("block-0", "Review details"), block("block-1", "Changes requested")]

        translated = provider._translate_sync(blocks, "en", "zh-Hant")

        self.assertEqual(translated, {"block-0": llama.translated_text, "block-1": llama.translated_text})
        self.assertEqual(len(llama.prompts), 2)
        self.assertIn("Input:\nReview details\nOutput:", llama.prompts[0])
        self.assertIn("Input:\nChanges requested\nOutput:", llama.prompts[1])

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

        with patch("overlay_backend.translation.providers.request.urlopen", side_effect=lambda req, timeout: Response(req)):
            result = RemoteHttpProvider("https://example.test/translate")._translate_sync(
                [block("a", "First"), block("b", "Second")], "en", "zh-Hant",
            )
        self.assertEqual(result, {"a": "translated:First", "b": "translated:Second"})
        self.assertEqual([payload["text"] for payload in payloads], ["First", "Second"])

    def test_empty_blocks_do_not_call_model(self) -> None:
        llama = _RecordingLlama("must not be used")
        provider = LocalLlamaProvider("unused.gguf")
        provider._llm = llama

        self.assertEqual(provider._translate_sync([], "en", "zh-Hant"), {})
        self.assertEqual(llama.prompt, "")


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

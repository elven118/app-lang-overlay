from __future__ import annotations

import unittest

from overlay_backend.domain import ClientSession, NormalizedBounds, TextBlock
from overlay_backend.pipeline import FramePipeline, LayoutAnalyzer
from overlay_backend.translation.providers import TranslationAlignmentError

from .helpers import StubTranslationProvider


class _UnusedOcr:
    def recognize(self, image_bytes: bytes, source_language: str) -> list[TextBlock]:
        raise AssertionError("device text test must not run OCR")


def block(identifier: str, text: str, x: float, y: float, width: float = 0.3, height: float = 0.08) -> TextBlock:
    return TextBlock(identifier, text, 0.9, NormalizedBounds(x, y, width, height), 99)


class LayoutTests(unittest.TestCase):
    def test_horizontal_order_is_top_to_bottom_then_left_to_right(self) -> None:
        ordered = LayoutAnalyzer.order(
            [block("third", "c", 0.6, 0.5), block("first", "a", 0.1, 0.1), block("second", "b", 0.5, 0.1)],
            "ja",
        )
        self.assertEqual([item.id for item in ordered], ["first", "second", "third"])
        self.assertEqual([item.reading_order for item in ordered], [0, 1, 2])

    def test_vertical_cjk_order_is_right_to_left(self) -> None:
        ordered = LayoutAnalyzer.order(
            [block("left", "後", 0.2, 0.1, 0.05, 0.3), block("right", "先", 0.8, 0.1, 0.05, 0.3)],
            "ja",
        )
        self.assertEqual([item.id for item in ordered], ["right", "left"])


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_each_block_keeps_its_translation_and_combined_reading_order(self) -> None:
        class ReorderedTranslator(StubTranslationProvider):
            async def translate_blocks(self, blocks, source_language, target_language):
                return {item.id: f"translated:{item.text}" for item in reversed(blocks)}

        pipeline = FramePipeline(_UnusedOcr(), ReorderedTranslator())
        session = ClientSession("one", "desktop", source_language="en")
        result = await pipeline.process_text(session, session.region("screen"), "screen", "1", [
            block("bottom", "Two", 0.1, 0.5), block("top", "One", 0.1, 0.1),
        ], "device-ocr")
        self.assertEqual([(b.source.id, b.translated_text) for b in result.blocks], [
            ("top", "translated:One"), ("bottom", "translated:Two"),
        ])
        self.assertEqual(result.combined_translated_text, "translated:One\ntranslated:Two")

    async def test_bad_alignment_does_not_replace_success_or_poison_cache_and_can_retry(self) -> None:
        class Translator(StubTranslationProvider):
            bad = False
            async def translate_blocks(self, blocks, source_language, target_language):
                if self.bad:
                    return {"__combined__": "must never display"}
                return await super().translate_blocks(blocks, source_language, target_language)

        translator = Translator()
        pipeline = FramePipeline(_UnusedOcr(), translator)
        session = ClientSession("one", "desktop")
        region = session.region("screen")
        first = await pipeline.process_text(session, region, "screen", "1", [block("a", "One", 0.1, 0.1)], "device-ocr")
        translator.bad = True
        changed = [block("a", "Two", 0.1, 0.1)]
        with self.assertRaises(TranslationAlignmentError):
            await pipeline.process_text(session, region, "screen", "2", changed, "device-ocr")
        self.assertEqual(region.last_dedupe_key, first.dedupe_key)
        self.assertEqual(len(pipeline.cache._values), 1)
        translator.bad = False
        retry = await pipeline.process_text(session, region, "screen", "3", changed, "device-ocr")
        self.assertEqual(retry.blocks[0].translated_text, "[zh-Hant] Two")

    async def test_cache_does_not_reuse_translations_for_different_block_ids(self) -> None:
        pipeline = FramePipeline(_UnusedOcr(), StubTranslationProvider())
        session = ClientSession("one", "desktop")
        region = session.region("screen")
        await pipeline.process_text(session, region, "screen", "1", [block("a", "Same", 0.1, 0.1)], "device-ocr")
        result = await pipeline.process_text(session, region, "screen", "2", [block("b", "Same", 0.1, 0.1)], "device-ocr")
        self.assertEqual(result.blocks[0].source.id, "b")
        self.assertEqual(result.blocks[0].translated_text, "[zh-Hant] Same")

    async def test_translation_deduplicates_within_one_region(self) -> None:
        pipeline = FramePipeline(_UnusedOcr(), StubTranslationProvider())  # type: ignore[arg-type]
        session = ClientSession("one", "ios")
        region = session.region("screen")
        blocks = [block("a", "今日は", 0.1, 0.1)]
        first = await pipeline.process_text(session, region, "screen", "1", blocks, "vision-ocr")
        second = await pipeline.process_text(session, region, "screen", "2", blocks, "vision-ocr")
        self.assertEqual(first.combined_translated_text, "[zh-Hant] 今日は")
        self.assertIsNotNone(first.blocks[0].source_reading_segments)
        self.assertEqual(first.blocks[0].source_reading_segments[-1].text, "は")
        self.assertIsNone(first.blocks[0].source_reading_segments[-1].reading)
        self.assertIsNone(second)

    async def test_dedupe_state_is_not_shared_between_sessions(self) -> None:
        pipeline = FramePipeline(_UnusedOcr(), StubTranslationProvider())  # type: ignore[arg-type]
        blocks = [block("a", "同じ", 0.1, 0.1)]
        first_session = ClientSession("one", "ios")
        second_session = ClientSession("two", "desktop")
        first = await pipeline.process_text(
            first_session, first_session.region("screen"), "screen", "1", blocks, "vision-ocr"
        )
        second = await pipeline.process_text(
            second_session, second_session.region("screen"), "screen", "1", blocks, "server-onnx"
        )
        self.assertIsNotNone(first)
        self.assertIsNotNone(second)

    async def test_same_text_with_new_ocr_ids_keeps_translations_aligned(self) -> None:
        pipeline = FramePipeline(_UnusedOcr(), StubTranslationProvider())  # type: ignore[arg-type]
        first_session = ClientSession("first", "desktop")
        second_session = ClientSession("second", "desktop")
        await pipeline.process_text(
            first_session, first_session.region("window"), "window", "1",
            [block("old-a", "First", .1, .1), block("old-b", "Second", .1, .3)], "server-onnx",
        )
        second = await pipeline.process_text(
            second_session, second_session.region("window"), "window", "1",
            [block("new-a", "First", .1, .1), block("new-b", "Second", .1, .3)], "server-onnx",
        )
        payload = second.as_dict()
        self.assertEqual([item["id"] for item in payload["blocks"]], ["new-a", "new-b"])
        self.assertTrue(all(item["translatedText"] for item in payload["blocks"]))


if __name__ == "__main__":
    unittest.main()

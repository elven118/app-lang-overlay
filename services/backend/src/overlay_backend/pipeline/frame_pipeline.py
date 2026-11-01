from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections import OrderedDict

from ..domain import ClientSession, ImageFrame, RegionState, TextBlock, TranslationBlock, TranslationResult
from ..ocr import PaddleOcrProvider
from ..translation import TranslationProvider
from .japanese_readings import source_reading_segments
from .layout import LayoutAnalyzer


class TranslationCache:
    def __init__(self, capacity: int = 256) -> None:
        self.capacity = capacity
        self._values: OrderedDict[str, dict[str, str]] = OrderedDict()

    def get(self, key: str) -> dict[str, str] | None:
        value = self._values.get(key)
        if value is not None:
            self._values.move_to_end(key)
            return dict(value)
        return None

    def put(self, key: str, value: dict[str, str]) -> None:
        self._values[key] = dict(value)
        self._values.move_to_end(key)
        while len(self._values) > self.capacity:
            self._values.popitem(last=False)


class FramePipeline:
    def __init__(self, ocr: PaddleOcrProvider, translator: TranslationProvider) -> None:
        self.ocr = ocr
        self.translator = translator
        self.layout = LayoutAnalyzer()
        self.cache = TranslationCache()

    @staticmethod
    def _normalized_text(blocks: list[TextBlock]) -> str:
        return "\n".join(" ".join(item.text.split()) for item in blocks if item.text.strip()).strip()

    async def process_text(
        self,
        session: ClientSession,
        region: RegionState,
        region_id: str,
        frame_id: str,
        blocks: list[TextBlock],
        ocr_provider: str,
    ) -> TranslationResult | None:
        return await self._process(session, region, region_id, frame_id, blocks, ocr_provider, 0.0)

    async def process_image(
        self,
        session: ClientSession,
        region: RegionState,
        frame: ImageFrame,
    ) -> TranslationResult | None:
        started = time.perf_counter()
        blocks = await asyncio.to_thread(self.ocr.recognize, frame.image_bytes, session.source_language)
        ocr_ms = (time.perf_counter() - started) * 1000
        return await self._process(
            session,
            region,
            frame.region_id,
            frame.frame_id,
            blocks,
            "server-onnx",
            ocr_ms,
        )

    async def _process(
        self,
        session: ClientSession,
        region: RegionState,
        region_id: str,
        frame_id: str,
        blocks: list[TextBlock],
        provider: str,
        ocr_ms: float,
    ) -> TranslationResult | None:
        pipeline_started = time.perf_counter()
        ordered = self.layout.order(blocks, session.source_language)
        source_text = self._normalized_text(ordered)
        if not source_text:
            region.empty_frame_count += 1
            return None
        region.empty_frame_count = 0
        dedupe_key = hashlib.sha256(
            f"{session.source_language}|{session.target_language}|{source_text}".encode("utf-8")
        ).hexdigest()[:16]
        if dedupe_key == region.last_dedupe_key:
            return None

        # Cached dictionaries are keyed by OCR IDs, which can change between
        # regions/frames even when the combined source text is identical.
        block_key = hashlib.sha256(json.dumps(
            [(item.id, item.text) for item in ordered], ensure_ascii=False,
        ).encode("utf-8")).hexdigest()
        cache_key = f"{self.translator.revision}|{dedupe_key}|{block_key}"
        translated_by_id = self.cache.get(cache_key)
        translation_started = time.perf_counter()
        if translated_by_id is None:
            translated_by_id = await self.translator.translate_blocks(
                ordered,
                session.source_language,
                session.target_language,
            )
            self.cache.put(cache_key, translated_by_id)
        translation_ms = (time.perf_counter() - translation_started) * 1000

        expected_ids = {item.id for item in ordered}
        aligned = set(translated_by_id) == expected_ids
        if aligned:
            combined_fallback = ""
        else:
            combined_fallback = str(translated_by_id.get("__combined__", "")).strip()
            if not combined_fallback:
                combined_fallback = "\n".join(
                    str(value).strip()
                    for key, value in translated_by_id.items()
                    if key != "__combined__" and str(value).strip()
                )

        translated_blocks = [
            TranslationBlock(
                source=item,
                translated_text=str(translated_by_id.get(item.id, "")) if aligned else "",
                source_reading_segments=(
                    source_reading_segments(item.text)
                    if session.source_language == "ja"
                    else None
                ),
            )
            for item in ordered
        ]
        combined_translation = combined_fallback or "\n".join(
            item.translated_text for item in translated_blocks if item.translated_text.strip()
        ).strip()
        region.last_dedupe_key = dedupe_key
        return TranslationResult(
            session_id=session.session_id,
            region_id=region_id,
            frame_id=frame_id,
            ocr_provider=provider,
            blocks=translated_blocks,
            combined_source_text=source_text,
            combined_translated_text=combined_translation,
            dedupe_key=dedupe_key,
            ocr_ms=ocr_ms,
            translation_ms=translation_ms,
            total_ms=ocr_ms + (time.perf_counter() - pipeline_started) * 1000,
        )

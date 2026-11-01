from __future__ import annotations

from dataclasses import dataclass, field
import math
from typing import Any, Literal


SOURCE_LANGUAGES = {"auto", "en", "ja", "ko", "zh-Hans", "zh-Hant"}
TARGET_LANGUAGES = {"en", "zh-Hant", "ja"}
CLIENT_KINDS = {"desktop", "ios", "android"}
OCR_PROVIDERS = {
    "tesseract",
    "google-mlkit",
    "device-ocr",
    "vision-ocr",
    "replaykit",
    "server-onnx",
}


class ProtocolError(ValueError):
    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


def require_string(value: Any, name: str, *, max_length: int = 128) -> str:
    if not isinstance(value, str) or not value or len(value) > max_length:
        raise ProtocolError("invalid_field", f"{name} must be a non-empty string")
    return value


def frame_number(value: Any) -> int:
    raw = require_string(value, "frameId", max_length=20)
    if not raw.isdecimal() or (len(raw) > 1 and raw.startswith("0")):
        raise ProtocolError("invalid_frame_id", "frameId must be a canonical decimal string")
    number = int(raw)
    if number > 2**64 - 1:
        raise ProtocolError("invalid_frame_id", "frameId exceeds UInt64")
    return number


@dataclass(frozen=True, slots=True)
class NormalizedBounds:
    x: float
    y: float
    width: float
    height: float

    @classmethod
    def from_dict(cls, value: Any) -> "NormalizedBounds":
        if not isinstance(value, dict) or set(value) != {"x", "y", "width", "height"}:
            raise ProtocolError("invalid_bounds", "bounds requires only x, y, width and height")
        raw_values = tuple(value[key] for key in ("x", "y", "width", "height"))
        if any(isinstance(item, bool) or not isinstance(item, (int, float)) for item in raw_values):
            raise ProtocolError("invalid_bounds", "bounds values must be numeric")
        try:
            bounds = cls(*(float(item) for item in raw_values))
        except (TypeError, ValueError) as exc:
            raise ProtocolError("invalid_bounds", "bounds values must be numeric") from exc
        if (
            not all(math.isfinite(item) for item in (bounds.x, bounds.y, bounds.width, bounds.height))
            or
            bounds.x < 0
            or bounds.y < 0
            or bounds.width <= 0
            or bounds.height <= 0
            or bounds.x + bounds.width > 1.000001
            or bounds.y + bounds.height > 1.000001
        ):
            raise ProtocolError("invalid_bounds", "bounds must fit inside normalized [0,1] coordinates")
        return bounds

    def as_dict(self) -> dict[str, float]:
        return {"x": self.x, "y": self.y, "width": self.width, "height": self.height}


@dataclass(frozen=True, slots=True)
class TextBlock:
    id: str
    text: str
    confidence: float
    bounds: NormalizedBounds
    reading_order: int

    @classmethod
    def from_dict(cls, value: Any) -> "TextBlock":
        required = {"id", "text", "confidence", "bounds", "readingOrder"}
        if not isinstance(value, dict) or set(value) != required:
            raise ProtocolError("invalid_block", "text block fields do not match protocol V1")
        block_id = require_string(value.get("id"), "block.id")
        text = require_string(value.get("text"), "block.text", max_length=16_000).strip()
        if not text:
            raise ProtocolError("invalid_block", "block.text must contain visible text")
        confidence_value = value.get("confidence")
        order_value = value.get("readingOrder")
        if (
            isinstance(confidence_value, bool)
            or not isinstance(confidence_value, (int, float))
            or isinstance(order_value, bool)
            or not isinstance(order_value, int)
        ):
            raise ProtocolError("invalid_block", "block confidence and readingOrder must be numeric")
        try:
            confidence = float(confidence_value)
            reading_order = order_value
        except (TypeError, ValueError) as exc:
            raise ProtocolError("invalid_block", "block confidence and readingOrder must be numeric") from exc
        if not math.isfinite(confidence) or not 0 <= confidence <= 1 or not 0 <= reading_order <= 99:
            raise ProtocolError("invalid_block", "block confidence or readingOrder is out of range")
        return cls(block_id, text, confidence, NormalizedBounds.from_dict(value.get("bounds")), reading_order)

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "text": self.text,
            "confidence": self.confidence,
            "bounds": self.bounds.as_dict(),
            "readingOrder": self.reading_order,
        }


@dataclass(frozen=True, slots=True)
class SourceReadingSegment:
    text: str
    reading: str | None

    def as_dict(self) -> dict[str, str | None]:
        return {"text": self.text, "reading": self.reading}


@dataclass(frozen=True, slots=True)
class TranslationBlock:
    source: TextBlock
    translated_text: str
    source_reading_segments: list[SourceReadingSegment] | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            **self.source.as_dict(),
            "translatedText": self.translated_text,
            "sourceReadingSegments": (
                None
                if self.source_reading_segments is None
                else [segment.as_dict() for segment in self.source_reading_segments]
            ),
        }


@dataclass(slots=True)
class RegionState:
    last_received_frame: int = -1
    last_result_frame: int = -1
    last_dedupe_key: str = ""
    empty_frame_count: int = 0


@dataclass(slots=True)
class ClientSession:
    session_id: str
    client_kind: Literal["desktop", "ios", "android"]
    source_language: str = "ja"
    target_language: str = "zh-Hant"
    image_upload_consent: bool = False
    paused: bool = False
    revision: int = 0
    last_received_frame: int = -1
    regions: dict[str, RegionState] = field(default_factory=dict)

    def update(self, settings: dict[str, Any]) -> None:
        allowed = {"sourceLanguage", "targetLanguage", "imageUploadConsent"}
        if not settings or not set(settings).issubset(allowed):
            raise ProtocolError("invalid_settings", "settings contains unsupported or no fields")
        source = settings.get("sourceLanguage", self.source_language)
        target = settings.get("targetLanguage", self.target_language)
        consent = settings.get("imageUploadConsent", self.image_upload_consent)
        if not isinstance(source, str) or source not in SOURCE_LANGUAGES:
            raise ProtocolError("unsupported_language", f"Unsupported source language: {source!r}")
        if not isinstance(target, str) or target not in TARGET_LANGUAGES:
            raise ProtocolError("unsupported_language", f"Unsupported target language: {target!r}")
        if not isinstance(consent, bool):
            raise ProtocolError("invalid_field", "imageUploadConsent must be a boolean")
        changed = (source, target, consent) != (
            self.source_language,
            self.target_language,
            self.image_upload_consent,
        )
        self.source_language = source
        self.target_language = target
        self.image_upload_consent = consent
        if changed:
            self.revision += 1
            for region in self.regions.values():
                region.last_dedupe_key = ""
                region.empty_frame_count = 0

    def region(self, region_id: str) -> RegionState:
        return self.regions.setdefault(region_id, RegionState())

    def as_dict(self, request_id: str) -> dict[str, Any]:
        return {
            "type": "session.state",
            "requestId": request_id,
            "sessionId": self.session_id,
            "sourceLanguage": self.source_language,
            "targetLanguage": self.target_language,
            "imageUploadConsent": self.image_upload_consent,
            "paused": self.paused,
        }


@dataclass(frozen=True, slots=True)
class ImageFrame:
    session_id: str
    region_id: str
    frame_id: str
    captured_at_ms: int
    frame_width: int
    frame_height: int
    mime_type: str
    client_ocr_diagnostics: dict[str, str]
    image_bytes: bytes


@dataclass(frozen=True, slots=True)
class TranslationResult:
    session_id: str
    region_id: str
    frame_id: str
    ocr_provider: str
    blocks: list[TranslationBlock]
    combined_source_text: str
    combined_translated_text: str
    dedupe_key: str
    ocr_ms: float
    translation_ms: float
    total_ms: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "type": "translation.result",
            "sessionId": self.session_id,
            "regionId": self.region_id,
            "frameId": self.frame_id,
            "ocrProvider": self.ocr_provider,
            "blocks": [item.as_dict() for item in self.blocks],
            "combinedSourceText": self.combined_source_text,
            "combinedTranslatedText": self.combined_translated_text,
            "dedupeKey": self.dedupe_key,
            "timingMs": {
                "ocr": round(self.ocr_ms, 2),
                "translation": round(self.translation_ms, 2),
                "total": round(self.total_ms, 2),
            },
        }

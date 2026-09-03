from __future__ import annotations

import json
import re
import struct
from dataclasses import dataclass
from typing import Any

from ..config import BackendSettings
from ..domain import ImageFrame, ProtocolError, TextBlock, frame_number, require_string


MAGIC = b"ALO1"
REGION_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


@dataclass(frozen=True, slots=True)
class TextFrame:
    session_id: str
    region_id: str
    frame_id: str
    captured_at_ms: int
    frame_width: int
    frame_height: int
    blocks: list[TextBlock]


def require_fields(
    message: dict[str, Any],
    *,
    required: set[str],
    optional: set[str] | None = None,
) -> None:
    optional = optional or set()
    missing = required - set(message)
    extra = set(message) - required - optional
    if missing:
        raise ProtocolError("missing_field", f"Missing required field: {sorted(missing)[0]}")
    if extra:
        raise ProtocolError("unexpected_field", f"Unexpected field: {sorted(extra)[0]}")


def parse_json_message(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ProtocolError("invalid_json", "Payload must be valid JSON") from exc
    if not isinstance(value, dict):
        raise ProtocolError("invalid_message", "Payload root must be an object")
    require_string(value.get("type"), "type", max_length=64)
    return value


def _frame_metadata(message: dict[str, Any]) -> tuple[str, str, str, int, int, int]:
    session_id = require_string(message.get("sessionId"), "sessionId")
    region_id = require_string(message.get("regionId"), "regionId", max_length=64)
    if REGION_ID_PATTERN.fullmatch(region_id) is None:
        raise ProtocolError("invalid_region_id", "regionId contains unsupported characters")
    frame_id = require_string(message.get("frameId"), "frameId", max_length=20)
    frame_number(frame_id)
    captured = message.get("capturedAtMs")
    width = message.get("frameWidth")
    height = message.get("frameHeight")
    if any(isinstance(item, bool) or not isinstance(item, int) for item in (captured, width, height)):
        raise ProtocolError("invalid_frame", "Frame dimensions and timestamp must be integers")
    if captured < 0 or not 1 <= width <= 8192 or not 1 <= height <= 8192:
        raise ProtocolError("invalid_frame", "Frame dimensions or timestamp are out of range")
    return session_id, region_id, frame_id, captured, width, height


def parse_text_frame(message: dict[str, Any], settings: BackendSettings) -> TextFrame:
    require_fields(
        message,
        required={
            "type",
            "sessionId",
            "regionId",
            "frameId",
            "capturedAtMs",
            "frameWidth",
            "frameHeight",
            "blocks",
        },
    )
    if message.get("type") != "frame.text":
        raise ProtocolError("invalid_message", "Expected frame.text")
    session_id, region_id, frame_id, captured, width, height = _frame_metadata(message)
    raw_blocks = message.get("blocks")
    if not isinstance(raw_blocks, list):
        raise ProtocolError("invalid_blocks", "blocks must be an array")
    if len(raw_blocks) > settings.max_blocks:
        raise ProtocolError("too_many_blocks", f"At most {settings.max_blocks} blocks are allowed")
    blocks = [TextBlock.from_dict(item) for item in raw_blocks]
    if len({item.id for item in blocks}) != len(blocks):
        raise ProtocolError("duplicate_block_id", "Text block IDs must be unique within a frame")
    if sum(len(item.text) for item in blocks) > settings.max_source_chars:
        raise ProtocolError("source_too_large", "Recognized source text exceeds the protocol limit")
    return TextFrame(session_id, region_id, frame_id, captured, width, height, blocks)


def encode_image_envelope(header: dict[str, Any], image_bytes: bytes) -> bytes:
    header_bytes = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return MAGIC + struct.pack(">I", len(header_bytes)) + header_bytes + image_bytes


def parse_image_envelope(raw: bytes, settings: BackendSettings) -> ImageFrame:
    if len(raw) < 8 or raw[:4] != MAGIC:
        raise ProtocolError("invalid_binary_magic", "Binary message must start with ALO1")
    header_length = struct.unpack(">I", raw[4:8])[0]
    if header_length <= 0:
        raise ProtocolError("invalid_header_size", "Binary JSON header must not be empty")
    if header_length > settings.max_header_bytes:
        raise ProtocolError("header_too_large", "Binary JSON header exceeds the 64 KiB limit")
    image_offset = 8 + header_length
    if image_offset > len(raw):
        raise ProtocolError("truncated_binary", "Binary message header is truncated")
    image_bytes = raw[image_offset:]
    if not image_bytes:
        raise ProtocolError("invalid_image_size", "JPEG payload must not be empty")
    if len(image_bytes) > settings.max_image_bytes:
        raise ProtocolError("image_too_large", "The JPEG payload exceeds the 4 MiB limit")
    try:
        header = json.loads(raw[8:image_offset].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError("invalid_binary_header", "Binary header must be valid UTF-8 JSON") from exc
    if not isinstance(header, dict):
        raise ProtocolError("invalid_binary_header", "Binary header must be an object")
    require_fields(
        header,
        required={
            "type",
            "sessionId",
            "regionId",
            "frameId",
            "capturedAtMs",
            "frameWidth",
            "frameHeight",
            "mimeType",
            "clientOcrDiagnostics",
        },
    )
    if header.get("type") != "frame.image":
        raise ProtocolError("invalid_binary_header", "Binary header type must be frame.image")
    if header.get("mimeType") != "image/jpeg":
        raise ProtocolError("unsupported_image_type", "Only image/jpeg is accepted")
    diagnostics = header.get("clientOcrDiagnostics")
    if (
        not isinstance(diagnostics, dict)
        or len(diagnostics) > 16
        or any(not isinstance(key, str) or not isinstance(value, str) or len(value) > 256 for key, value in diagnostics.items())
    ):
        raise ProtocolError("invalid_diagnostics", "clientOcrDiagnostics must contain at most 16 short strings")
    session_id, region_id, frame_id, captured, width, height = _frame_metadata(header)
    return ImageFrame(
        session_id=session_id,
        region_id=region_id,
        frame_id=frame_id,
        captured_at_ms=captured,
        frame_width=width,
        frame_height=height,
        mime_type="image/jpeg",
        client_ocr_diagnostics=dict(diagnostics),
        image_bytes=image_bytes,
    )


def error_payload(
    error: ProtocolError,
    *,
    request_id: str | None = None,
    session_id: str | None = None,
    region_id: str | None = None,
    frame_id: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "error",
        "code": error.code,
        "message": error.message,
        "retryable": error.retryable,
    }
    for key, value in (
        ("requestId", request_id),
        ("sessionId", session_id),
        ("regionId", region_id),
        ("frameId", frame_id),
    ):
        if value:
            payload[key] = value
    return payload

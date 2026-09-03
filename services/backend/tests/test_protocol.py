from __future__ import annotations

import json
import struct
import unittest
from pathlib import Path

from overlay_backend.api.protocol import encode_image_envelope, parse_image_envelope, parse_text_frame
from overlay_backend.config import BackendSettings
from overlay_backend.domain import ProtocolError


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPOSITORY_ROOT / "shared" / "protocol" / "v1" / "fixtures"


class ProtocolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = BackendSettings()

    def test_shared_text_fixture_decodes(self) -> None:
        payload = json.loads((FIXTURES / "frame.text.json").read_text(encoding="utf-8"))
        frame = parse_text_frame(payload, self.settings)
        self.assertEqual(frame.frame_id, "42")
        self.assertEqual(frame.region_id, "screen")
        self.assertEqual(frame.blocks[0].text, "今日は")
        self.assertEqual(frame.blocks[0].bounds.x, 0.1)

    def test_image_envelope_round_trip(self) -> None:
        header = json.loads((FIXTURES / "frame.image-header.json").read_text(encoding="utf-8"))
        encoded = encode_image_envelope(header, b"jpeg-data")
        decoded = parse_image_envelope(encoded, self.settings)
        self.assertEqual(decoded.session_id, "desktop-a1")
        self.assertEqual(decoded.region_id, "dialogue-1")
        self.assertEqual(decoded.image_bytes, b"jpeg-data")

    def test_rejects_oversized_binary_header_before_decoding(self) -> None:
        raw = b"ALO1" + struct.pack(">I", self.settings.max_header_bytes + 1) + b"{}"
        with self.assertRaisesRegex(ProtocolError, "64 KiB"):
            parse_image_envelope(raw, self.settings)

    def test_rejects_source_character_limit(self) -> None:
        payload = json.loads((FIXTURES / "frame.text.json").read_text(encoding="utf-8"))
        payload["blocks"][0]["text"] = "x" * 101
        settings = BackendSettings(max_source_chars=100)
        with self.assertRaisesRegex(ProtocolError, "source text exceeds"):
            parse_text_frame(payload, settings)

    def test_rejects_duplicate_block_ids(self) -> None:
        payload = json.loads((FIXTURES / "frame.text.json").read_text(encoding="utf-8"))
        payload["blocks"].append({**payload["blocks"][0], "text": "duplicate"})
        with self.assertRaisesRegex(ProtocolError, "IDs must be unique"):
            parse_text_frame(payload, self.settings)


if __name__ == "__main__":
    unittest.main()

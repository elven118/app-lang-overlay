from __future__ import annotations

import asyncio
import json
import unittest

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from overlay_backend.api import WebSocketGateway
from overlay_backend.config import BackendSettings
from overlay_backend.domain import TextBlock
from overlay_backend.pipeline import FramePipeline
from overlay_backend.services import SessionRegistry

from .helpers import StubTranslationProvider


class _UnusedOcr:
    def recognize(self, image_bytes: bytes, source_language: str) -> list[TextBlock]:
        raise AssertionError("gateway device text test must not run OCR")


class _SlowTranslator:
    revision = "slow-test-v1"

    async def translate_blocks(self, blocks: list[TextBlock], source_language: str, target_language: str) -> dict[str, str]:
        await asyncio.sleep(0.1)
        return {item.id: f"translated:{item.text}" for item in blocks}


def text_frame(frame_id: str, text: str = "こんにちは", region_id: str = "screen") -> dict[str, object]:
    blocks: list[dict[str, object]] = []
    if text:
        blocks.append(
            {
                "id": "b0",
                "text": text,
                "confidence": 0.95,
                "bounds": {"x": 0.1, "y": 0.1, "width": 0.5, "height": 0.1},
                "readingOrder": 0,
            }
        )
    return {
        "type": "frame.text",
        "sessionId": "test-session",
        "regionId": region_id,
        "frameId": frame_id,
        "capturedAtMs": 1787623200000,
        "frameWidth": 1000,
        "frameHeight": 1000,
        "blocks": blocks,
    }


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.settings = BackendSettings(api_token="secret")
        self.registry = SessionRegistry()
        self.gateway = WebSocketGateway(
            self.settings,
            self.registry,
            FramePipeline(_UnusedOcr(), StubTranslationProvider()),  # type: ignore[arg-type]
        )
        self.server_context = serve(self.gateway.handle_client, "127.0.0.1", 0)
        self.server = await self.server_context.__aenter__()
        self.port = self.server.sockets[0].getsockname()[1]

    async def asyncTearDown(self) -> None:
        await self.server_context.__aexit__(None, None, None)

    def open(self):
        return connect(
            f"ws://127.0.0.1:{self.port}/v1/stream",
            additional_headers={"Authorization": "Bearer secret"},
        )

    async def hello_and_start(self, websocket) -> None:
        await websocket.send(
            json.dumps(
                {
                    "type": "client.hello",
                    "protocolVersion": 1,
                    "clientKind": "ios",
                    "appVersion": "test",
                    "ocrProviders": ["vision-ocr", "server-onnx"],
                }
            )
        )
        self.assertEqual(json.loads(await websocket.recv())["type"], "server.ready")
        await websocket.send(
            json.dumps(
                {
                    "type": "session.start",
                    "requestId": "start-1",
                    "sessionId": "test-session",
                    "sourceLanguage": "ja",
                    "targetLanguage": "zh-Hant",
                    "imageUploadConsent": False,
                }
            )
        )
        state = json.loads(await websocket.recv())
        self.assertEqual(state["type"], "session.state")
        self.assertEqual(state["requestId"], "start-1")

    async def test_requires_bearer_token(self) -> None:
        async with connect(f"ws://127.0.0.1:{self.port}/v1/stream") as websocket:
            error = json.loads(await websocket.recv())
            self.assertEqual(error["code"], "unauthorized")

    async def test_text_translation_and_two_sample_clear(self) -> None:
        async with self.open() as websocket:
            await self.hello_and_start(websocket)
            await websocket.send(json.dumps(text_frame("1")))
            result = json.loads(await websocket.recv())
            self.assertEqual(result["type"], "translation.result")
            self.assertEqual(result["ocrProvider"], "vision-ocr")
            self.assertEqual(result["combinedTranslatedText"], "[zh-Hant] こんにちは")

            await websocket.send(json.dumps(text_frame("2", "")))
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(websocket.recv(), timeout=0.05)
            await websocket.send(json.dumps(text_frame("3", "")))
            cleared = json.loads(await websocket.recv())
            self.assertEqual(cleared["type"], "translation.clear")
            self.assertEqual(cleared["frameId"], "3")

            await websocket.send(json.dumps(text_frame("4")))
            restored = json.loads(await websocket.recv())
            self.assertEqual(restored["type"], "translation.result")

    async def test_rejects_stale_frame_without_closing_session(self) -> None:
        async with self.open() as websocket:
            await self.hello_and_start(websocket)
            await websocket.send(json.dumps(text_frame("5")))
            self.assertEqual(json.loads(await websocket.recv())["type"], "translation.result")
            await websocket.send(json.dumps(text_frame("4", "changed")))
            error = json.loads(await websocket.recv())
            self.assertEqual(error["code"], "stale_frame")

    async def test_inflight_result_completes_and_newest_queued_frame_wins(self) -> None:
        self.gateway.pipeline.translator = _SlowTranslator()
        async with self.open() as websocket:
            await self.hello_and_start(websocket)
            await websocket.send(json.dumps(text_frame("10", "old")))
            await asyncio.sleep(0.01)
            await websocket.send(json.dumps(text_frame("11", "replaced")))
            await websocket.send(json.dumps(text_frame("12", "new")))

            inflight = json.loads(await websocket.recv())
            self.assertEqual(inflight["type"], "translation.result")
            self.assertEqual(inflight["frameId"], "10")
            self.assertEqual(inflight["combinedSourceText"], "old")

            newest = json.loads(await websocket.recv())
            self.assertEqual(newest["type"], "translation.result")
            self.assertEqual(newest["frameId"], "12")
            self.assertEqual(newest["combinedSourceText"], "new")


if __name__ == "__main__":
    unittest.main()

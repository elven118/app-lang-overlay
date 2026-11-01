from __future__ import annotations

import asyncio
import copy
import hmac
import json
import logging
from dataclasses import dataclass
from typing import Any, Literal

from websockets.exceptions import ConnectionClosed

from ..config import BackendSettings
from ..domain import (
    ClientSession,
    ImageFrame,
    ProtocolError,
    RegionState,
    TextBlock,
    frame_number,
    require_string,
)
from ..domain.models import CLIENT_KINDS, OCR_PROVIDERS
from ..pipeline import FramePipeline
from ..services import SessionRegistry
from .protocol import (
    TextFrame,
    error_payload,
    parse_image_envelope,
    parse_json_message,
    parse_text_frame,
    require_fields,
)


LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class _QueuedFrame:
    kind: Literal["text", "image"]
    region_id: str
    frame_id: str
    session_revision: int
    ocr_provider: str = "server-onnx"
    blocks: list[TextBlock] | None = None
    image: ImageFrame | None = None


@dataclass(slots=True)
class _RegionQueue:
    pending: _QueuedFrame | None
    event: asyncio.Event
    task: asyncio.Task[None] | None


class WebSocketGateway:
    def __init__(self, settings: BackendSettings, registry: SessionRegistry, pipeline: FramePipeline) -> None:
        self.settings = settings
        self.registry = registry
        self.pipeline = pipeline

    async def handle_client(self, websocket: Any) -> None:
        session: ClientSession | None = None
        client_kind: Literal["desktop", "ios", "android"] | None = None
        client_ocr_providers: list[str] = []
        region_queues: dict[str, _RegionQueue] = {}
        send_lock = asyncio.Lock()

        async def send(payload: dict[str, Any]) -> None:
            async with send_lock:
                await websocket.send(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))

        async def region_worker(region_id: str, queue: _RegionQueue) -> None:
            nonlocal session
            while True:
                await queue.event.wait()
                queued = queue.pending
                queue.pending = None
                queue.event.clear()
                if queued is None:
                    continue
                active = session
                if active is None or active.paused or active.revision != queued.session_revision:
                    continue
                live_region = active.regions.get(region_id)
                if live_region is None:
                    continue
                isolated_session = copy.copy(active)
                isolated_region = copy.copy(live_region)
                try:
                    if queued.kind == "text":
                        result = await self.pipeline.process_text(
                            isolated_session,
                            isolated_region,
                            region_id,
                            queued.frame_id,
                            queued.blocks or [],
                            queued.ocr_provider,
                        )
                    else:
                        assert queued.image is not None
                        result = await self.pipeline.process_image(isolated_session, isolated_region, queued.image)
                except ProtocolError as error:
                    await send(
                        error_payload(
                            error,
                            session_id=active.session_id,
                            region_id=region_id,
                            frame_id=queued.frame_id,
                        )
                    )
                    continue
                except Exception:
                    LOGGER.exception(
                        "Frame processing failed session=%s region=%s frame=%s kind=%s",
                        active.session_id,
                        region_id,
                        queued.frame_id,
                        queued.kind,
                    )
                    await send(
                        error_payload(
                            ProtocolError(
                                "frame_processing_failed",
                                "The backend could not process this frame",
                                retryable=True,
                            ),
                            session_id=active.session_id,
                            region_id=region_id,
                            frame_id=queued.frame_id,
                        )
                    )
                    continue

                active = session
                current_region = active.regions.get(region_id) if active is not None else None
                if (
                    active is None
                    or active.paused
                    or current_region is None
                    or active.revision != queued.session_revision
                    or frame_number(queued.frame_id) <= current_region.last_result_frame
                ):
                    continue
                current_region.empty_frame_count = isolated_region.empty_frame_count
                current_region.last_dedupe_key = isolated_region.last_dedupe_key
                if result is not None:
                    current_region.last_result_frame = frame_number(queued.frame_id)
                    await send(result.as_dict())
                elif current_region.empty_frame_count == 2:
                    current_region.last_dedupe_key = ""
                    current_region.last_result_frame = frame_number(queued.frame_id)
                    await send(
                        {
                            "type": "translation.clear",
                            "sessionId": active.session_id,
                            "regionId": region_id,
                            "frameId": queued.frame_id,
                            "reason": "stable-empty",
                        }
                    )

        def queue_for(region_id: str) -> _RegionQueue:
            queue = region_queues.get(region_id)
            if queue is None:
                queue = _RegionQueue(None, asyncio.Event(), None)
                queue.task = asyncio.create_task(region_worker(region_id, queue), name=f"overlay-region-{region_id}")
                region_queues[region_id] = queue
            return queue

        def require_session(message_session_id: Any) -> ClientSession:
            active = session
            message_id = require_string(message_session_id, "sessionId")
            if active is None or active.session_id != message_id:
                raise ProtocolError("session_missing", "Start this session before sending messages")
            return active

        def enqueue(active: ClientSession, queued: _QueuedFrame) -> None:
            number = frame_number(queued.frame_id)
            if number <= active.last_received_frame:
                raise ProtocolError("stale_frame", "frameId must increase monotonically within the session")
            active.last_received_frame = number
            region = active.region(queued.region_id)
            region.last_received_frame = number
            queue = queue_for(queued.region_id)
            queue.pending = queued
            queue.event.set()

        async def cancel_region(region_id: str) -> None:
            queue = region_queues.pop(region_id, None)
            if queue is None:
                return
            if queue.task is None:
                return
            queue.task.cancel()
            try:
                await queue.task
            except asyncio.CancelledError:
                pass

        async def cancel_all_regions() -> None:
            await asyncio.gather(
                *(cancel_region(region_id) for region_id in list(region_queues)),
                return_exceptions=True,
            )

        try:
            if websocket.request.path != "/v1/stream":
                await websocket.close(code=1008, reason="Use /v1/stream")
                return
            if self.settings.api_token:
                expected = f"Bearer {self.settings.api_token}"
                supplied = websocket.request.headers.get("Authorization", "")
                if not hmac.compare_digest(supplied, expected):
                    await send(error_payload(ProtocolError("unauthorized", "A valid bearer token is required")))
                    await websocket.close(code=1008, reason="Unauthorized")
                    return

            async for raw in websocket:
                message: dict[str, Any] | None = None
                try:
                    if isinstance(raw, bytes):
                        if client_kind is None:
                            raise ProtocolError("handshake_required", "Send client.hello before frame data")
                        if "server-onnx" not in client_ocr_providers:
                            raise ProtocolError("image_not_supported", "Client did not advertise server-onnx")
                        frame = parse_image_envelope(raw, self.settings)
                        active = require_session(frame.session_id)
                        if not active.image_upload_consent:
                            raise ProtocolError("image_consent_required", "Image upload consent is required")
                        enqueue(
                            active,
                            _QueuedFrame("image", frame.region_id, frame.frame_id, active.revision, image=frame),
                        )
                        continue

                    message = parse_json_message(raw)
                    message_type = message["type"]
                    if message_type == "client.hello":
                        require_fields(
                            message,
                            required={"type", "protocolVersion", "clientKind", "appVersion", "ocrProviders"},
                        )
                        if client_kind is not None:
                            raise ProtocolError("duplicate_hello", "client.hello was already accepted")
                        if message.get("protocolVersion") != 1:
                            raise ProtocolError("unsupported_protocol", "Only protocol version 1 is supported")
                        kind = message.get("clientKind")
                        if kind not in CLIENT_KINDS:
                            raise ProtocolError("invalid_client", "Unsupported clientKind")
                        require_string(message.get("appVersion"), "appVersion", max_length=64)
                        providers = message.get("ocrProviders")
                        if (
                            not isinstance(providers, list)
                            or not 1 <= len(providers) <= 16
                            or any(not isinstance(provider, str) for provider in providers)
                            or any(provider not in OCR_PROVIDERS for provider in providers)
                            or len(set(providers)) != len(providers)
                        ):
                            raise ProtocolError("invalid_ocr_providers", "ocrProviders must contain unique supported values")
                        client_kind = kind
                        client_ocr_providers = list(providers)
                        await send({"type": "server.ready", "protocolVersion": 1, "ocrProviders": ["server-onnx"]})
                    elif message_type == "ping":
                        require_fields(message, required={"type", "requestId"})
                        await send({"type": "pong", "requestId": require_string(message.get("requestId"), "requestId")})
                    elif client_kind is None:
                        raise ProtocolError("handshake_required", "Send client.hello before starting a session")
                    elif message_type == "session.start":
                        require_fields(
                            message,
                            required={"type", "requestId", "sessionId", "sourceLanguage", "targetLanguage", "imageUploadConsent"},
                        )
                        if session is not None:
                            raise ProtocolError("session_exists", "This connection already owns a session")
                        request_id = require_string(message.get("requestId"), "requestId")
                        session_id = require_string(message.get("sessionId"), "sessionId")
                        created = ClientSession(session_id=session_id, client_kind=client_kind)
                        created.update(
                            {
                                "sourceLanguage": message["sourceLanguage"],
                                "targetLanguage": message["targetLanguage"],
                                "imageUploadConsent": message["imageUploadConsent"],
                            }
                        )
                        session = await self.registry.create(created)
                        await send(session.as_dict(request_id))
                    elif message_type == "session.update":
                        require_fields(message, required={"type", "requestId", "sessionId", "settings"})
                        active = require_session(message.get("sessionId"))
                        request_id = require_string(message.get("requestId"), "requestId")
                        patch = message.get("settings")
                        if not isinstance(patch, dict):
                            raise ProtocolError("invalid_settings", "settings must be an object")
                        active.update(patch)
                        for queue in region_queues.values():
                            queue.pending = None
                            queue.event.clear()
                        await send(active.as_dict(request_id))
                    elif message_type in {"session.pause", "session.resume"}:
                        require_fields(message, required={"type", "requestId", "sessionId"})
                        active = require_session(message.get("sessionId"))
                        request_id = require_string(message.get("requestId"), "requestId")
                        paused = message_type == "session.pause"
                        if paused and not active.paused:
                            active.revision += 1
                            for queue in region_queues.values():
                                queue.pending = None
                                queue.event.clear()
                        active.paused = paused
                        await send(active.as_dict(request_id))
                    elif message_type == "region.remove":
                        require_fields(message, required={"type", "requestId", "sessionId", "regionId"})
                        active = require_session(message.get("sessionId"))
                        require_string(message.get("requestId"), "requestId")
                        region_id = require_string(message.get("regionId"), "regionId", max_length=64)
                        region = active.regions.pop(region_id, None)
                        await cancel_region(region_id)
                        if region is not None and region.last_received_frame >= 0:
                            await send(
                                {
                                    "type": "translation.clear",
                                    "sessionId": active.session_id,
                                    "regionId": region_id,
                                    "frameId": str(region.last_received_frame),
                                    "reason": "region-removed",
                                }
                            )
                    elif message_type == "session.end":
                        require_fields(message, required={"type", "requestId", "sessionId"})
                        active = require_session(message.get("sessionId"))
                        require_string(message.get("requestId"), "requestId")
                        regions = list(active.regions.items())
                        await cancel_all_regions()
                        for region_id, region in regions:
                            if region.last_received_frame >= 0:
                                await send(
                                    {
                                        "type": "translation.clear",
                                        "sessionId": active.session_id,
                                        "regionId": region_id,
                                        "frameId": str(region.last_received_frame),
                                        "reason": "session-ended",
                                    }
                                )
                        await self.registry.remove(active.session_id)
                        session = None
                    elif message_type == "frame.text":
                        frame: TextFrame = parse_text_frame(message, self.settings)
                        active = require_session(frame.session_id)
                        provider = next(
                            (
                                item
                                for item in client_ocr_providers
                                if item not in {"server-onnx", "replaykit"}
                            ),
                            "",
                        )
                        if not provider:
                            raise ProtocolError("text_not_supported", "Client did not advertise a device OCR provider")
                        enqueue(
                            active,
                            _QueuedFrame(
                                "text",
                                frame.region_id,
                                frame.frame_id,
                                active.revision,
                                ocr_provider=provider,
                                blocks=frame.blocks,
                            ),
                        )
                    else:
                        raise ProtocolError("unknown_message", f"Unsupported message type: {message_type}")
                except ProtocolError as error:
                    await send(
                        error_payload(
                            error,
                            request_id=message.get("requestId") if message and isinstance(message.get("requestId"), str) else None,
                            session_id=message.get("sessionId") if message and isinstance(message.get("sessionId"), str) else None,
                            region_id=message.get("regionId") if message and isinstance(message.get("regionId"), str) else None,
                            frame_id=message.get("frameId") if message and isinstance(message.get("frameId"), str) else None,
                        )
                    )
                except Exception:
                    LOGGER.exception("WebSocket message processing failed")
                    await send(
                        error_payload(
                            ProtocolError(
                                "internal_error",
                                "The backend could not process this message",
                                retryable=True,
                            )
                        )
                    )
        except ConnectionClosed:
            pass
        finally:
            await cancel_all_regions()
            if session is not None:
                await self.registry.remove(session.session_id)

from __future__ import annotations

import asyncio
import signal

from dotenv import load_dotenv
from websockets.asyncio.server import serve

from .api import WebSocketGateway
from .config import BackendSettings
from .ocr import PaddleOcrProvider
from .pipeline import FramePipeline
from .services import SessionRegistry
from .translation import build_translation_provider


async def run_overlay_backend(settings: BackendSettings | None = None) -> None:
    settings = settings or BackendSettings.from_env()
    gateway = WebSocketGateway(
        settings,
        SessionRegistry(),
        FramePipeline(PaddleOcrProvider(), build_translation_provider(settings)),
    )
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for name in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(name, stop.set)
        except NotImplementedError:
            pass

    max_message_size = settings.max_image_bytes + settings.max_header_bytes + 8
    async with serve(gateway.handle_client, settings.host, settings.port, max_size=max_message_size):
        print(f"[overlay-backend] protocol v1 listening on ws://{settings.host}:{settings.port}/v1/stream")
        await stop.wait()


def main() -> None:
    load_dotenv(override=False)
    asyncio.run(run_overlay_backend(BackendSettings.from_env()))


if __name__ == "__main__":
    main()

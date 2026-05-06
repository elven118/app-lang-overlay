from __future__ import annotations

import asyncio
import contextlib
import traceback
from typing import Iterable

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from .ax_source import ax_stream
from .llm import LocalTranslator
from .ocr import ocr_stream
from .textproc import dedupe_key, normalize_for_compare


def fake_stream(game: str) -> Iterable[dict]:
    import time

    samples = [
        ("おはよう。", ""),
        ("ここは危ない、早く行こう。", ""),
        ("準備はいい？", ""),
        ("うん、行こう。", ""),
    ]
    idx = 0
    while True:
        source, translated = samples[idx % len(samples)]
        idx += 1
        now = time.time()
        yield {
            "type": "subtitle",
            "profile": game,
            "timestamp": now,
            "source_text": source,
            "translated_text": translated,
            "lang_src": "auto",
            "lang_dst": "en",
            "confidence": 0.95,
            "dedupe_key": f"{source}:{translated}",
            "hide_after_ms": 5000,
        }


async def run_overlay_backend(
    host: str,
    port: int,
    game: str,
    interval_ms: int,
    input_mode: str,
    ocr_lang: str,
    dedupe_window_ms: int,
) -> None:
    clients: set = set()
    stop = asyncio.Event()
    translator = LocalTranslator(target_lang="繁體中文")

    async def handler(ws):
        clients.add(ws)
        print(f"[overlay-backend] client connected total={len(clients)}")
        try:
            await ws.wait_closed()
        finally:
            clients.discard(ws)
            print(f"[overlay-backend] client disconnected total={len(clients)}")

    async def publish(message: dict) -> None:
        if not clients:
            return
        import json

        payload = json.dumps(message, ensure_ascii=False)
        stale = []
        for client in list(clients):
            try:
                await client.send(payload)
            except ConnectionClosed:
                stale.append(client)
        for client in stale:
            clients.discard(client)

    async def publisher() -> None:
        last_emitted_compare = ""
        last_emitted_at = 0.0
        blank_since = 0.0
        last_empty_notice_at = 0.0

        if input_mode == "fake":
            source = fake_stream(game)
            while not stop.is_set():
                event = next(source)
                await publish(event)
                await asyncio.sleep(max(interval_ms, 100) / 1000)
            return

        if input_mode not in ("ocr", "accessibility"):
            raise RuntimeError("--input-mode must be one of: fake, ocr, accessibility")

        while not stop.is_set():
            try:
                stream = (
                    ocr_stream(game, interval_ms, ocr_lang)
                    if input_mode == "ocr"
                    else ax_stream(game, interval_ms)
                )
                async for event in stream:
                    if stop.is_set():
                        return

                    text = event["source_text"]
                    now = float(event["timestamp"])
                    compare_text = normalize_for_compare(text)

                    if not text:
                        if blank_since == 0.0:
                            blank_since = now
                        if now - blank_since >= 1.0:
                            await publish(
                                {
                                    "type": "clear",
                                    "profile": game,
                                    "timestamp": now,
                                    "reason": "empty_ocr",
                                }
                            )
                        if input_mode == "ocr" and now - last_empty_notice_at >= 5.0:
                            last_empty_notice_at = now
                            await publish(
                                {
                                    "type": "subtitle",
                                    "profile": game,
                                    "timestamp": now,
                                    "source_text": "OCR running (no text detected)",
                                    "translated_text": "",
                                    "lang_src": "auto",
                                    "lang_dst": "en",
                                    "confidence": 0.0,
                                    "dedupe_key": "ocr-empty-notice",
                                    "hide_after_ms": 1500,
                                }
                            )
                        continue

                    blank_since = 0.0

                    same_text = compare_text == last_emitted_compare
                    in_window = (now - last_emitted_at) * 1000 < max(dedupe_window_ms, 0)
                    if same_text and in_window:
                        continue

                    last_emitted_compare = compare_text
                    last_emitted_at = now
                    translated = await translator.translate(text)
                    event["source_text"] = text
                    event["translated_text"] = translated
                    event["dedupe_key"] = dedupe_key(translated or text)
                    await publish(event)
            except Exception as exc:
                print(f"[overlay-backend] OCR loop error: {exc}")
                traceback.print_exc()
                await asyncio.sleep(1.0)

    loop = asyncio.get_running_loop()
    import signal

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass

    async with serve(handler, host, port):
        print(
            f"[overlay-backend] websocket on ws://{host}:{port} profile={game} mode={input_mode}"
        )
        pub_task = asyncio.create_task(publisher())
        await stop.wait()
        pub_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await pub_task

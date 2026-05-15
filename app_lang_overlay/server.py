from __future__ import annotations

import asyncio
import contextlib
import traceback
from collections import OrderedDict
from typing import Iterable

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from .ax_source import ax_stream
from .config import get_overlay_auto_hide_ms
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
            "dedupe_key": f"{source}:{translated}",
            "hide_after_ms": 5000,
        }


async def run_overlay_backend(
    host: str,
    port: int,
    game: str,
    poll_ms: int,
    input_mode: str,
    ocr_lang: str,
    auto_hide_ms: int,
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
        blank_since = 0.0
        hide_sent_for_blank = False
        overlay_visible = False
        translation_by_key: OrderedDict[str, str] = OrderedDict()
        translation_cache_limit = 64
        last_empty_notice_at = 0.0

        if input_mode == "fake":
            source = fake_stream(game)
            while not stop.is_set():
                event = next(source)
                await publish(event)
                await asyncio.sleep(max(poll_ms, 100) / 1000)
            return

        if input_mode not in ("ocr", "accessibility"):
            raise RuntimeError("--input-mode must be one of: fake, ocr, accessibility")

        while not stop.is_set():
            try:
                stream = (
                    ocr_stream(game, poll_ms, ocr_lang)
                    if input_mode == "ocr"
                    else ax_stream(game, poll_ms)
                )
                async for event in stream:
                    if stop.is_set():
                        return

                    text = event["source_text"]
                    now = float(event["timestamp"])
                    compare_text = normalize_for_compare(text)
                    current_auto_hide_ms = get_overlay_auto_hide_ms(game, default_ms=auto_hide_ms)

                    if not text:
                        if blank_since == 0.0:
                            blank_since = now
                        hide_timeout_s = max(poll_ms + max(current_auto_hide_ms, 0), 0) / 1000.0
                        if (
                            current_auto_hide_ms >= 0
                            and overlay_visible
                            and not hide_sent_for_blank
                            and now - blank_since >= hide_timeout_s
                        ):
                            hide_sent_for_blank = True
                            overlay_visible = False
                            await publish(
                                {
                                    "type": "subtitle_hide",
                                    "profile": game,
                                    "timestamp": now,
                                    "reason": "no_text_timeout",
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
                                    "dedupe_key": "ocr-empty-notice",
                                    "hide_after_ms": -1,
                                }
                            )
                        continue

                    blank_since = 0.0
                    hide_sent_for_blank = False

                    if compare_text == last_emitted_compare:
                        continue

                    last_emitted_compare = compare_text
                    source_key = dedupe_key(text)
                    cached = translation_by_key.get(source_key)
                    if cached is not None:
                        translated = cached
                        translation_by_key.move_to_end(source_key)
                    else:
                        translated = await translator.translate(text)
                        translation_by_key[source_key] = translated
                        if len(translation_by_key) > translation_cache_limit:
                            translation_by_key.popitem(last=False)
                    event["source_text"] = text
                    event["translated_text"] = translated
                    event["dedupe_key"] = source_key
                    event["hide_after_ms"] = -1
                    overlay_visible = True
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

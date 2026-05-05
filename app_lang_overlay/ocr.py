from __future__ import annotations

import asyncio
import os
import time
from typing import AsyncIterator

from .config import get_ocr_lang, profile_path, try_load_capture_region
from .textproc import confidence_for_text, dedupe_key, normalize_text


async def ocr_stream(game: str, interval_ms: int, ocr_lang: str) -> AsyncIterator[dict]:
    try:
        import mss
        import pytesseract
        from PIL import Image, ImageOps
    except ImportError as exc:
        raise RuntimeError("OCR mode requires dependencies: mss, pillow, pytesseract") from exc

    region: dict | None = None
    interval_s = max(interval_ms, 100) / 1000
    region_log_cooldown_s = 2.0
    last_region_log_at = 0.0
    active_ocr_lang = ocr_lang

    tesseract_cmd = os.environ.get("TESSERACT_CMD", "/opt/homebrew/bin/tesseract").strip()
    if tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = tesseract_cmd

    try:
        tesseract_version = str(pytesseract.get_tesseract_version())
        print(
            f"[overlay-backend] tesseract={tesseract_version} "
            f"cmd={pytesseract.pytesseract.tesseract_cmd}"
        )
    except Exception as exc:
        raise RuntimeError(
            "Tesseract binary not found. Install Tesseract OCR and ensure it's in PATH, "
            "or set TESSERACT_CMD=/full/path/to/tesseract."
        ) from exc

    with mss.MSS() as sct:
        while True:
            latest_region = try_load_capture_region(game)
            now = time.time()
            if latest_region is None:
                if now - last_region_log_at >= region_log_cooldown_s:
                    print(f"[overlay-backend] waiting for capture_region in {profile_path(game)}")
                    last_region_log_at = now
                await asyncio.sleep(interval_s)
                continue

            if latest_region != region:
                region = latest_region
                print(f"[overlay-backend] OCR region={region} lang={active_ocr_lang}")

            current_lang = get_ocr_lang(game, default_lang=ocr_lang)
            if current_lang != active_ocr_lang:
                active_ocr_lang = current_lang
                print(f"[overlay-backend] OCR language switched to: {active_ocr_lang}")

            shot = sct.grab(region)
            image = Image.frombytes("RGB", shot.size, shot.rgb)
            image = ImageOps.autocontrast(ImageOps.grayscale(image))
            raw = pytesseract.image_to_string(
                image, lang=active_ocr_lang, config="--oem 3 --psm 6"
            )
            text = normalize_text(raw)
            now = time.time()
            yield {
                "type": "subtitle",
                "profile": game,
                "timestamp": now,
                "source_text": text,
                "translated_text": "",
                "lang_src": "auto",
                "lang_dst": "en",
                "confidence": confidence_for_text(text),
                "dedupe_key": dedupe_key(text),
                "hide_after_ms": 2200,
            }
            await asyncio.sleep(interval_s)

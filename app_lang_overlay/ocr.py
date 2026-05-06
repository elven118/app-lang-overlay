from __future__ import annotations

import asyncio
import time
from typing import AsyncIterator

import mss
from PIL import Image
import numpy as np
import cv2
from paddleocr import PaddleOCR 

from .config import get_ocr_lang, profile_path, try_load_capture_region
from .textproc import confidence_for_text, dedupe_key, normalize_text


async def ocr_stream(game: str, interval_ms: int, ocr_lang: str) -> AsyncIterator[dict]:
    region: dict | None = None
    interval_s = max(interval_ms, 100) / 1000
    region_log_cooldown_s = 2.0
    last_region_log_at = 0.0
    active_ocr_lang = ocr_lang
    last_debug_at = 0.0

    ocr_instances: dict[str, PaddleOCR] = {}

    def get_ocr_for_lang(lang: str) -> PaddleOCR:
        existing = ocr_instances.get(lang)
        if existing is not None:
            return existing
        print(f"[overlay-backend] init PaddleOCR lang={lang}")
        inst = PaddleOCR(
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            lang=lang,

            det_db_box_thresh=0.6,
            det_db_unclip_ratio=1.4,
            rec_batch_num=1
        )
        ocr_instances[lang] = inst
        return inst

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

            ocr = get_ocr_for_lang(active_ocr_lang)
            shot = sct.grab(region)
            image = Image.frombytes("RGB", shot.size, shot.rgb)
            image_np = np.array(image)
            img_bgr = cv2.cvtColor(image_np, cv2.COLOR_RGB2BGR)
            raw = ocr.ocr(img_bgr)
            texts = []
            if raw and isinstance(raw, list) and len(raw) > 0:
                res = raw[0]
                if 'rec_texts' in res:
                    for text_content, score in zip(res['rec_texts'], res['rec_scores']):
                        if score > 0.6 and len(text_content.strip()) > 0:
                            texts.append(text_content.strip())
            text = "\n".join(texts)
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
                "hide_after_ms": 5000,
            }
            await asyncio.sleep(interval_s)

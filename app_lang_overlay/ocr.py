from __future__ import annotations

import asyncio
import time
from typing import Any, AsyncIterator

import cv2
import mss
import numpy as np
from PIL import Image

from .config import get_ocr_lang, profile_path, try_load_capture_region
from .text_det import OnnxTextDetector
from .text_rec import OnnxTextRecognizer
from .textproc import confidence_for_text, dedupe_key


def _crop_rotated_text_region(image_bgr: np.ndarray, box: np.ndarray) -> np.ndarray | None:
    """Perspective-crop a 4-point text box into a horizontal text line patch."""
    if box.shape != (4, 2):
        return None

    pts = box.astype(np.float32)

    width_top = float(np.linalg.norm(pts[0] - pts[1]))
    width_bottom = float(np.linalg.norm(pts[2] - pts[3]))
    height_left = float(np.linalg.norm(pts[0] - pts[3]))
    height_right = float(np.linalg.norm(pts[1] - pts[2]))

    dst_w = max(1, int(round(max(width_top, width_bottom))))
    dst_h = max(1, int(round(max(height_left, height_right))))

    if dst_w < 2 or dst_h < 2:
        return None

    dst = np.array(
        [
            [0, 0],
            [dst_w - 1, 0],
            [dst_w - 1, dst_h - 1],
            [0, dst_h - 1],
        ],
        dtype=np.float32,
    )

    transform = cv2.getPerspectiveTransform(pts, dst)
    crop = cv2.warpPerspective(
        image_bgr,
        transform,
        (dst_w, dst_h),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )

    # Keep recognizer input mostly horizontal.
    if crop.shape[0] / max(crop.shape[1], 1) >= 1.5:
        crop = np.rot90(crop)

    return crop


def _extract_text_crops(
    image_bgr: np.ndarray,
    det_results: list[dict[str, Any]],
    min_det_score: float = 0.5,
) -> list[np.ndarray]:
    crops: list[np.ndarray] = []

    for item in det_results:
        score = float(item.get("score", 0.0))
        if score < min_det_score:
            continue

        box = item.get("box")
        if not isinstance(box, np.ndarray):
            box = np.array(box)

        if box.shape != (4, 2):
            continue

        crop = _crop_rotated_text_region(image_bgr, box)
        if crop is None:
            continue

        crops.append(crop)

    return crops


async def ocr_stream(game: str, interval_ms: int, ocr_lang: str) -> AsyncIterator[dict]:
    region: dict | None = None
    interval_s = max(interval_ms, 100) / 1000
    region_log_cooldown_s = 2.0
    last_region_log_at = 0.0
    active_ocr_lang = (ocr_lang or "en").strip() or "en"

    ocr_det = OnnxTextDetector()
    ocr_rec_instances: dict[str, OnnxTextRecognizer] = {}

    def get_ocr_for_lang(lang: str) -> OnnxTextRecognizer:
        key = (lang or "en").strip() or "en"
        existing = ocr_rec_instances.get(key)
        if existing is not None:
            return existing
        inst = OnnxTextRecognizer(key)
        ocr_rec_instances[key] = inst
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

            current_lang = (get_ocr_lang(game, default_lang=ocr_lang) or "en").strip() or "en"
            if current_lang != active_ocr_lang:
                active_ocr_lang = current_lang
                print(f"[overlay-backend] OCR language switched to: {active_ocr_lang}")

            ocr_rec = get_ocr_for_lang(active_ocr_lang)

            shot = sct.grab(region)
            image = Image.frombytes("RGB", shot.size, shot.rgb)
            image_rgb = np.array(image)
            image_bgr = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR)

            det_results = ocr_det.predict(image)
            crops = _extract_text_crops(image_bgr, det_results)
            sentence_results = ocr_rec.predict_sentences(crops)

            text = "\n".join(item["text"] for item in sentence_results if item.get("text"))
            
            yield {
                "type": "subtitle",
                "profile": game,
                "timestamp": time.time(),
                "source_text": text,
                "translated_text": "",
                "lang_src": "auto",
                "lang_dst": "en",
                "confidence": confidence_for_text(text),
                "dedupe_key": dedupe_key(text),
                "hide_after_ms": 5000,
            }
            await asyncio.sleep(interval_s)

from __future__ import annotations

import asyncio
import json
import math
import time
from pathlib import Path
from typing import AsyncIterator

import cv2
import mss
import numpy as np
import onnxruntime as ort
from PIL import Image

from .config import get_ocr_lang, profile_path, try_load_capture_region
from .textproc import confidence_for_text, dedupe_key, normalize_text


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODELS_ROOT = PROJECT_ROOT / "models"

DET_MODEL_PATH = MODELS_ROOT / "det_onnx" / "PP-OCRv5_server_det.onnx"
REC_MODEL_BY_LANG = {
    "en": (
        MODELS_ROOT / "rec_onnx" / "en_PP-OCRv5_mobile_rec.onnx",
        MODELS_ROOT / ".paddlex" / "official_models" / "en_PP-OCRv5_mobile_rec" / "config.json",
    ),
    "korean": (
        MODELS_ROOT / "rec_onnx" / "korean_PP-OCRv5_mobile_rec.onnx",
        MODELS_ROOT / ".paddlex" / "official_models" / "korean_PP-OCRv5_mobile_rec" / "config.json",
    ),
}
DEFAULT_REC_MODEL = (
    MODELS_ROOT / "rec_onnx" / "PP-OCRv5_server_rec.onnx",
    MODELS_ROOT / ".paddlex" / "official_models" / "PP-OCRv5_server_rec" / "config.json",
)

# DET_LIMIT_SIDE_LEN = 960
# DET_THRESH = 0.3
DET_BOX_THRESH = 0.6
# DET_UNCLIP_RATIO = 1.4
# DET_MAX_CANDIDATES = 1000
# DET_STD = [0.5, 0.5, 0.5]

REC_IMAGE_HEIGHT = 48
REC_BASE_WIDTH = 320
REC_MAX_WIDTH = 3200
REC_SCORE_THRESH = 0.6


def _make_session(model_path: Path) -> ort.InferenceSession:
    if not model_path.exists():
        raise FileNotFoundError(f"ONNX model not found: {model_path}")
    return ort.InferenceSession(str(model_path))


class OnnxTextDetector:
    def __init__(self) -> None:
        print(f"[overlay-backend] init ONNX text detector model={DET_MODEL_PATH}")
        self.session = _make_session(DET_MODEL_PATH)
        self.input_name = self.session.get_inputs()[0].name

class OnnxTextRecognizer:
    def __init__(self, lang: str) -> None:
        paths = REC_MODEL_BY_LANG.get(lang, DEFAULT_REC_MODEL)
        model_path, config_path = paths
        with open(config_path, 'r', encoding='utf-8') as f:
            self.config = json.load(f)
        self.session = _make_session(model_path)
        self.input_name = self.session.get_inputs()[0].name

def _preprocess_image(pil_image):
    image = np.array(pil_image)
    height, width = image.shape[:2]
    # Resize input dimensions multiples of 32
    target_h = max(32, int(math.ceil(height / 32.0) * 32))
    target_w = max(32, int(math.ceil(width / 32.0) * 32))
    if target_h != height or target_w != width:
        image = cv2.resize(image, (target_w, target_h), interpolation=cv2.INTER_LINEAR)
    normalized_image = image.astype(np.float32) / 255.0
    transposed_image = np.transpose(normalized_image, (2, 0, 1))
    input_tensor = np.expand_dims(transposed_image, axis=0).astype(np.float32)
    return input_tensor, target_w, target_h

def _write_boxes_on_image(image: Image.Image, boxes: list[tuple[int, int, int, int]]) -> Image.Image:
    print(f"[overlay-backend] detected {len(boxes)} text boxes")
    img_bgr = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
    for box in boxes:
        x_min, y_min, x_max, y_max = map(int, box[:4])
        cv2.rectangle(img_bgr, (x_min, y_min), (x_max, y_max), (0, 255, 0), 2)
    cv2.imwrite("debug_boxes.jpg", img_bgr)
    return image

def _to_xyxy_boxes(
    det_output: np.ndarray,
    image_width: int,
    image_height: int,
    input_width: int,
    input_height: int,
) -> list[np.ndarray]:
    print(f"[overlay-backend] raw detection output shape: {det_output.shape}")
    arr = np.asarray(det_output)
    # Expected direct box format: [N, >=5] where first 4 are normalized xyxy and 5th is score.
    if arr.ndim == 2 and arr.shape[1] >= 5:
        scale = np.array([image_width, image_height, image_width, image_height], dtype=np.float32)
        scaled = arr[:, :4] * scale
        scores = arr[:, 4]
        print(f"[overlay-backend] scaled boxes shape: {scaled.shape}, scores shape: {scores.shape}")
        return [scaled[i] for i in range(len(scaled)) if scores[i] > DET_BOX_THRESH]

    # DB-style probability map: [1, 1, H, W]
    if arr.ndim == 4 and arr.shape[0] == 1 and arr.shape[1] == 1:
        prob_map = np.clip(arr[0, 0], 0.0, 1.0)
        upsampled = cv2.resize(prob_map, (input_width, input_height), interpolation=cv2.INTER_LINEAR)
        mask = (upsampled > DET_BOX_THRESH).astype(np.uint8) * 255
        contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        scale_x = image_width / max(input_width, 1)
        scale_y = image_height / max(input_height, 1)
        boxes: list[np.ndarray] = []
        for cnt in contours:
            if cv2.contourArea(cnt) < 16:
                continue
            x, y, w, h = cv2.boundingRect(cnt)
            if w < 2 or h < 2:
                continue
            x1 = int(round(x * scale_x))
            y1 = int(round(y * scale_y))
            x2 = int(round((x + w) * scale_x))
            y2 = int(round((y + h) * scale_y))
            x1 = max(0, min(x1, image_width - 1))
            y1 = max(0, min(y1, image_height - 1))
            x2 = max(0, min(x2, image_width - 1))
            y2 = max(0, min(y2, image_height - 1))
            if x2 > x1 and y2 > y1:
                boxes.append(np.array([x1, y1, x2, y2], dtype=np.float32))
        print(f"[overlay-backend] detected {len(boxes)} map-derived text boxes")
        return boxes

    print(f"[overlay-backend] unexpected detection output shape: {arr.shape}")
    return []

async def ocr_stream(game: str, interval_ms: int, ocr_lang: str) -> AsyncIterator[dict]:
    region: dict | None = None
    interval_s = max(interval_ms, 100) / 1000
    region_log_cooldown_s = 2.0
    last_region_log_at = 0.0
    active_ocr_lang = ocr_lang

    ocr_det: OnnxTextDetector | None = None
    ocr_rec_instances: dict[str, OnnxTextRecognizer] = {}

    if ocr_det is None:
        ocr_det = OnnxTextDetector()
    def get_ocr_for_lang(lang: str) -> OnnxTextRecognizer:
        existing = ocr_rec_instances.get(lang)
        if existing is not None:
            return existing
        inst = OnnxTextRecognizer(lang)
        ocr_rec_instances[lang] = inst
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

            ocr_rec = get_ocr_for_lang(active_ocr_lang)
            shot = sct.grab(region)
            image = Image.frombytes("RGB", shot.size, shot.rgb)
            img_processed, input_w, input_h = _preprocess_image(image)
            input_name = ocr_det.input_name
            outputs = ocr_det.session.run(None, {input_name: img_processed})
            boxes_raw = outputs[0]
            image_width, image_height = image.size
            boxes = _to_xyxy_boxes(
                boxes_raw, image_width, image_height, input_w, input_h
            )
            image_with_boxes = _write_boxes_on_image(image, boxes)
            
            # texts = ocr_rec.session.run(None, {input_name: img_processed})
            # texts = [
            #     text.strip()
            #     for text, score in ocr.ocr(img_bgr)
            #     if score > REC_SCORE_THRESH and text.strip()
            # ]
            # text = normalize_text("\n".join(texts))
            text = ""
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

from __future__ import annotations

import io
import threading
from typing import Any

import cv2
import numpy as np
from PIL import Image

from ..domain import NormalizedBounds, ProtocolError, TextBlock


def _crop_rotated_text_region(image_bgr: np.ndarray, box: np.ndarray) -> np.ndarray | None:
    """Perspective-crop a quadrilateral and rotate tall text into recognizer orientation."""
    if box.shape != (4, 2):
        return None
    points = box.astype(np.float32)
    width = max(np.linalg.norm(points[0] - points[1]), np.linalg.norm(points[2] - points[3]))
    height = max(np.linalg.norm(points[0] - points[3]), np.linalg.norm(points[1] - points[2]))
    destination_width = max(1, int(round(float(width))))
    destination_height = max(1, int(round(float(height))))
    if destination_width < 2 or destination_height < 2:
        return None
    destination = np.array(
        [
            [0, 0],
            [destination_width - 1, 0],
            [destination_width - 1, destination_height - 1],
            [0, destination_height - 1],
        ],
        dtype=np.float32,
    )
    transform = cv2.getPerspectiveTransform(points, destination)
    crop = cv2.warpPerspective(
        image_bgr,
        transform,
        (destination_width, destination_height),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )
    if crop.shape[0] / max(crop.shape[1], 1) >= 1.5:
        crop = np.rot90(crop)
    return crop


def _extract_text_crops(
    image_bgr: np.ndarray,
    detections: list[dict[str, Any]],
    min_detection_score: float = 0.5,
) -> list[np.ndarray]:
    crops: list[np.ndarray] = []
    for detection in detections:
        if float(detection.get("score", 0)) < min_detection_score:
            continue
        box = np.asarray(detection.get("box"))
        crop = _crop_rotated_text_region(image_bgr, box)
        if crop is not None:
            crops.append(crop)
    return crops


class PaddleOcrProvider:
    name = "server-onnx"

    def __init__(self, min_detection_score: float = 0.5, min_text_score: float = 0.5) -> None:
        self.min_detection_score = min_detection_score
        self.min_text_score = min_text_score
        self._detector: Any = None
        self._recognizers: dict[str, Any] = {}
        self._lock = threading.Lock()

    def _ensure_detector(self) -> Any:
        if self._detector is None:
            from .text_det import OnnxTextDetector

            self._detector = OnnxTextDetector()
        return self._detector

    def _recognizer(self, source_language: str) -> Any:
        language = {
            "en": "en",
            "ko": "korean",
            "ja": "japan",
            "zh-Hans": "pp",
            "zh-Hant": "pp",
            "auto": "pp",
        }.get(source_language, "pp")
        recognizer = self._recognizers.get(language)
        if recognizer is None:
            from .text_rec import OnnxTextRecognizer

            recognizer = OnnxTextRecognizer(language)
            self._recognizers[language] = recognizer
        return recognizer

    def recognize(self, image_bytes: bytes, source_language: str) -> list[TextBlock]:
        try:
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        except Exception as exc:
            raise ProtocolError("invalid_image", "JPEG payload could not be decoded") from exc
        image_rgb = np.asarray(image)
        image_bgr = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR)
        height, width = image_rgb.shape[:2]
        with self._lock:
            detections = self._ensure_detector().predict(image)
            kept: list[tuple[dict[str, Any], np.ndarray]] = []
            for detection in detections:
                if float(detection.get("score", 0)) < self.min_detection_score:
                    continue
                crop = _crop_rotated_text_region(image_bgr, np.asarray(detection.get("box")))
                if crop is not None:
                    kept.append((detection, crop))
            if not kept:
                return []
            recognized = self._recognizer(source_language).predict(
                [crop for _, crop in kept],
                as_sentences=False,
            )

        blocks: list[TextBlock] = []
        for index, ((detection, _), result) in enumerate(zip(kept, recognized)):
            text = str(result.get("text", "")).strip()
            confidence = float(result.get("score", 0))
            if not text or confidence < self.min_text_score:
                continue
            box = np.asarray(detection["box"], dtype=np.float32)
            x_min = max(0.0, float(box[:, 0].min()) / max(width, 1))
            y_min = max(0.0, float(box[:, 1].min()) / max(height, 1))
            x_max = min(1.0, float(box[:, 0].max()) / max(width, 1))
            y_max = min(1.0, float(box[:, 1].max()) / max(height, 1))
            if x_max <= x_min or y_max <= y_min:
                continue
            blocks.append(
                TextBlock(
                    id=f"block-{index}",
                    text=text,
                    confidence=max(0.0, min(1.0, confidence)),
                    bounds=NormalizedBounds(x_min, y_min, x_max - x_min, y_max - y_min),
                    reading_order=index,
                )
            )
        return blocks

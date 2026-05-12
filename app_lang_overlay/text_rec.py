from __future__ import annotations

from pathlib import Path
import re
from typing import Any

import cv2
import numpy as np
from PIL import Image
import onnxruntime as ort

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODELS_ROOT = PROJECT_ROOT / "models"

REC_DEFAULT_MODEL_PATH = MODELS_ROOT / "rec_onnx" / "PP-OCRv5_rec.onnx"
REC_DEFAULT_DICT_PATH = PROJECT_ROOT / "app_lang_overlay" / "utils" / "dicts" / "ppocrv5_dict.txt"

REC_MODEL_BY_LANG = {
    "en": MODELS_ROOT / "rec_onnx" / "en_PP-OCRv5_mobile_rec.onnx",
    "korean": MODELS_ROOT / "rec_onnx" / "korean_PP-OCRv5_mobile_rec.onnx",
}
REC_DICT_BY_LANG = {
    "pp": REC_DEFAULT_DICT_PATH,
    "japan": REC_DEFAULT_DICT_PATH,
    "en": PROJECT_ROOT / "app_lang_overlay" / "utils" / "dicts" / "ppocrv5_en_dict.txt",
    "korean": PROJECT_ROOT / "app_lang_overlay" / "utils" / "dicts" / "ppocrv5_korean_dict.txt",
}

REC_IMAGE_SHAPE = (3, 48, 320)
REC_BATCH_NUM = 16
REC_MIN_TEXT_SCORE = 0.5
REC_USE_SPACE_CHAR = True
REC_DYNAMIC_MAX_WIDTH = 1600

_SENTENCE_END_RE = re.compile(r"[.!?。！？…]+(?:[\"'”’）)\]]+)?$")


class OnnxTextRecognizer:
    def __init__(self, lang: str = "en") -> None:
        self.lang = lang or "en"
        self.model_path, self.dict_path = self._resolve_model_and_dict_paths(self.lang)
        print(
            f"[overlay-backend] init ONNX text recognizer model={self.model_path} dict={self.dict_path} lang={self.lang}"
        )
        self.session = ort.InferenceSession(str(self.model_path))
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name
        input_shape = self.session.get_inputs()[0].shape
        self.input_img_c = int(input_shape[1]) if isinstance(input_shape[1], int) else 3
        self.input_img_h = int(input_shape[2]) if isinstance(input_shape[2], int) else REC_IMAGE_SHAPE[1]
        self.input_img_w = int(input_shape[3]) if isinstance(input_shape[3], int) else None

        self.character = self._load_character_dict(self.dict_path)

    def predict(
        self,
        img_list: list[np.ndarray | Image.Image],
        as_sentences: bool = False,
        min_text_score: float = REC_MIN_TEXT_SCORE,
    ) -> list[dict[str, Any]]:
        """
        Input:
            list of cropped text-line images.

        Output (as_sentences=False):
            [
                {"text": "hello", "score": 0.98},
                ...
            ]

        Output (as_sentences=True):
            [
                {"text": "Hello world.", "score": 0.95, "parts": 2},
                ...
            ]
        """
        preprocessed = self.pre_process_images(img_list)
        line_results = self._run_and_decode(preprocessed)

        if as_sentences:
            return self.post_process_sentences(line_results, min_text_score=min_text_score)

        return line_results

    def predict_sentences(
        self,
        img_list: list[np.ndarray | Image.Image],
        min_text_score: float = REC_MIN_TEXT_SCORE,
    ) -> list[dict[str, Any]]:
        """Convenience wrapper for sentence-level OCR output."""
        return self.predict(
            img_list,
            as_sentences=True,
            min_text_score=min_text_score,
        )

    def pre_process_images(self, img_list: list[np.ndarray | Image.Image]) -> list[np.ndarray]:
        """Recognizer preprocess: RGB conversion + resize/normalize/pad."""
        if not img_list:
            return []

        prepared_imgs: list[np.ndarray] = []

        for img in img_list:
            if isinstance(img, Image.Image):
                img = np.array(img.convert("RGB"))

            if img is None:
                continue

            if img.ndim == 2:
                img = cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
            elif img.ndim == 3 and img.shape[2] == 4:
                img = cv2.cvtColor(img, cv2.COLOR_RGBA2RGB)

            if img.ndim != 3 or img.shape[2] != 3:
                continue

            prepared_imgs.append(img)

        return prepared_imgs

    def _run_and_decode(self, prepared_imgs: list[np.ndarray]) -> list[dict[str, Any]]:
        """Run ONNX inference in batches and decode CTC outputs."""
        if not prepared_imgs:
            return []

        img_num = len(prepared_imgs)
        width_list = [img.shape[1] / float(max(img.shape[0], 1)) for img in prepared_imgs]
        indices = np.argsort(np.array(width_list))
        rec_res: list[dict[str, Any]] = [{"text": "", "score": 0.0}] * img_num

        for beg in range(0, img_num, REC_BATCH_NUM):
            end = min(img_num, beg + REC_BATCH_NUM)

            max_wh_ratio = 0.0
            for ino in range(beg, end):
                img = prepared_imgs[int(indices[ino])]
                h, w = img.shape[:2]
                max_wh_ratio = max(max_wh_ratio, w / float(max(h, 1)))

            norm_img_batch: list[np.ndarray] = []
            for ino in range(beg, end):
                img = prepared_imgs[int(indices[ino])]
                norm_img = self._resize_norm_img(img, max_wh_ratio=max_wh_ratio)
                norm_img_batch.append(norm_img[np.newaxis, :])

            batch_tensor = np.concatenate(norm_img_batch).astype(np.float32)

            outputs = self.session.run(
                [self.output_name],
                {self.input_name: batch_tensor},
            )

            preds = outputs[0]
            batch_results = self._decode(preds)

            for rno, item in enumerate(batch_results):
                rec_res[int(indices[beg + rno])] = item

        return rec_res

    def post_process_sentences(
        self,
        line_results: list[dict[str, Any]],
        min_text_score: float = REC_MIN_TEXT_SCORE,
    ) -> list[dict[str, Any]]:
        """Merge line-level recognizer outputs into sentence-level text blocks."""
        sentence_results: list[dict[str, Any]] = []

        text_parts: list[str] = []
        score_parts: list[float] = []

        def flush() -> None:
            if not text_parts:
                return
            sentence_text = " ".join(text_parts).strip()
            if sentence_text:
                sentence_results.append(
                    {
                        "text": sentence_text,
                        "score": float(np.mean(score_parts)) if score_parts else 0.0,
                        "parts": len(text_parts),
                    }
                )
            text_parts.clear()
            score_parts.clear()

        for item in line_results:
            text = self._normalize_text_piece(str(item.get("text", "")))
            score = float(item.get("score", 0.0))

            if not text or score < min_text_score:
                flush()
                continue

            text_parts.append(text)
            score_parts.append(score)

            if _SENTENCE_END_RE.search(text):
                flush()

        flush()

        return sentence_results

    def _resize_norm_img(self, img: np.ndarray, max_wh_ratio: float = 1.0) -> np.ndarray:
        """
        PaddleOCR recognizer style preprocessing.

        Input image:
            RGB ndarray, HWC, uint8

        Output:
            CHW float32, shape=(3, 48, 320)
        """
        img_c = self.input_img_c
        img_h = self.input_img_h

        if self.input_img_w is not None:
            img_w = self.input_img_w
        else:
            img_w = int(np.ceil(img_h * max(max_wh_ratio, 1.0)))
            img_w = max(REC_IMAGE_SHAPE[2], img_w)
            img_w = min(img_w, REC_DYNAMIC_MAX_WIDTH)

        h, w = img.shape[:2]
        ratio = w / float(max(h, 1))

        resized_w = int(np.ceil(img_h * ratio))
        resized_w = min(resized_w, img_w)
        resized_w = max(1, resized_w)

        resized_img = cv2.resize(img, (resized_w, img_h))

        resized_img = resized_img.astype("float32")
        resized_img = resized_img / 255.0
        resized_img = (resized_img - 0.5) / 0.5

        resized_img = resized_img.transpose(2, 0, 1)

        padding_img = np.zeros((img_c, img_h, img_w), dtype=np.float32)
        padding_img[:, :, :resized_w] = resized_img

        return padding_img

    def _decode(self, preds: np.ndarray) -> list[dict[str, Any]]:
        """
        CTC greedy decode.

        Common output:
            shape=(batch, sequence_length, num_classes)
        """
        if preds.ndim != 3:
            raise ValueError(f"Unexpected recognizer output shape: {preds.shape}")

        pred_indices = preds.argmax(axis=2)
        pred_scores = preds.max(axis=2)

        results: list[dict[str, Any]] = []

        for batch_idx in range(pred_indices.shape[0]):
            char_indices = pred_indices[batch_idx]
            char_scores = pred_scores[batch_idx]

            text = ""
            scores: list[float] = []
            last_idx = -1

            for idx, score in zip(char_indices, char_scores):
                idx = int(idx)

                # CTC blank is usually 0.
                if idx == 0:
                    last_idx = idx
                    continue

                # Remove duplicate continuous characters.
                if idx == last_idx:
                    last_idx = idx
                    continue

                char_pos = idx - 1

                if 0 <= char_pos < len(self.character):
                    text += self.character[char_pos]
                    scores.append(float(score))

                last_idx = idx

            avg_score = float(np.mean(scores)) if scores else 0.0

            results.append(
                {
                    "text": text,
                    "score": avg_score,
                }
            )

        return results

    def _normalize_text_piece(self, text: str) -> str:
        text = text.strip()
        text = re.sub(r"\s+", " ", text)
        return text

    def _resolve_model_and_dict_paths(self, lang: str) -> tuple[Path, Path]:
        requested_model = REC_MODEL_BY_LANG.get(lang, REC_DEFAULT_MODEL_PATH)
        requested_dict = REC_DICT_BY_LANG.get(lang, REC_DEFAULT_DICT_PATH)

        if requested_model.exists():
            model_path = requested_model
        else:
            if lang in REC_MODEL_BY_LANG:
                print(
                    f"[overlay-backend] recognizer model for lang={lang} missing; fallback to {REC_DEFAULT_MODEL_PATH}"
                )
            model_path = REC_DEFAULT_MODEL_PATH

        if not model_path.exists():
            raise FileNotFoundError(f"Recognizer model not found: {model_path}")

        if requested_dict.exists():
            dict_path = requested_dict
        else:
            if lang in REC_DICT_BY_LANG:
                print(
                    f"[overlay-backend] recognizer dict for lang={lang} missing; fallback to {REC_DEFAULT_DICT_PATH}"
                )
            dict_path = REC_DEFAULT_DICT_PATH

        if not dict_path.exists():
            raise FileNotFoundError(
                f"Recognizer dictionary not found for lang={lang}: {requested_dict} "
                f"and fallback missing: {REC_DEFAULT_DICT_PATH}"
            )

        return model_path, dict_path

    def _load_character_dict(self, dict_path: Path) -> list[str]:
        if not dict_path.exists():
            raise FileNotFoundError(
                f"Recognizer dictionary not found: {dict_path}\n"
                "You need the character dictionary that matches your PP-OCRv5 recognition model."
            )

        with dict_path.open("r", encoding="utf-8") as f:
            character = [line.rstrip("\n\r") for line in f]

        # PaddleOCR CTCLabelDecode compatibility: allow explicit space token.
        if REC_USE_SPACE_CHAR and " " not in character:
            character.append(" ")

        return character

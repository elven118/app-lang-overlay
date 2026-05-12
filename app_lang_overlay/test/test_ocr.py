from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from ..ocr import _crop_rotated_text_region
from ..text_det import OnnxTextDetector
from ..text_rec import OnnxTextRecognizer


def draw_det_boxes(image: Image.Image, results: list[dict]) -> Image.Image:
    img = np.array(image.convert("RGB")).copy()

    for item in results:
        box = item["box"].astype(np.int32)
        score = float(item["score"])
        cv2.polylines(img, [box], isClosed=True, color=(0, 255, 0), thickness=2)

        x, y = box[0]
        cv2.putText(
            img,
            f"{score:.2f}",
            (int(x), int(y) - 4),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (255, 0, 0),
            1,
            cv2.LINE_AA,
        )

    return Image.fromarray(img)


def draw_ocr_results(
    image: Image.Image,
    det_items: list[dict],
    rec_items: list[dict],
) -> Image.Image:
    img = np.array(image.convert("RGB")).copy()

    for idx, (det_item, rec_item) in enumerate(zip(det_items, rec_items)):
        box = det_item["box"].astype(np.int32)
        det_score = float(det_item["score"])
        rec_text = str(rec_item.get("text", ""))
        rec_score = float(rec_item.get("score", 0.0))

        cv2.polylines(img, [box], isClosed=True, color=(0, 255, 0), thickness=2)
        x, y = box[0]
        label = f"{idx}: {rec_text} ({rec_score:.2f}/{det_score:.2f})"
        cv2.putText(
            img,
            label,
            (int(x), max(15, int(y) - 6)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            (255, 255, 0),
            1,
            cv2.LINE_AA,
        )

    return Image.fromarray(img)


def main() -> None:
    image_path = Path("test.jpg")
    det_vis_path = Path("det_test_result.jpg")
    ocr_vis_path = Path("ocr_test_result.jpg")
    crop_dir = Path("app_lang_overlay/test/debug_crops")
    log_path = Path("ocr_test_result.txt")
    min_det_score = 0.5
    rec_lang = "en"

    crop_dir.mkdir(parents=True, exist_ok=True)

    image = Image.open(image_path).convert("RGB")
    image_rgb = np.array(image)
    image_bgr = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR)

    detector = OnnxTextDetector()
    recognizer = OnnxTextRecognizer(lang=rec_lang)

    print("=== detector ===")
    det_results = detector.predict(image)
    print("detected boxes:", len(det_results))
    for i, item in enumerate(det_results[:30]):
        print(i, "det_score:", float(item["score"]), "box:", item["box"].tolist())

    det_vis = draw_det_boxes(image, det_results)
    det_vis.save(det_vis_path)
    print("saved detector visualization:", det_vis_path.resolve())

    print("\n=== crop extraction ===")
    kept_det_items: list[dict] = []
    crops: list[np.ndarray] = []

    for idx, item in enumerate(det_results):
        det_score = float(item["score"])
        if det_score < min_det_score:
            continue
        box = item["box"]
        if not isinstance(box, np.ndarray) or box.shape != (4, 2):
            continue

        crop = _crop_rotated_text_region(image_bgr, box)
        if crop is None:
            continue

        kept_det_items.append(item)
        crops.append(crop)

        crop_path = crop_dir / f"crop_{len(crops)-1:03d}.jpg"
        cv2.imwrite(str(crop_path), crop)

    print("kept boxes for recognition:", len(crops))
    print("saved crops dir:", crop_dir.resolve())

    print("\n=== recognizer (line level) ===")
    rec_results = recognizer.predict(crops, as_sentences=False)
    for i, item in enumerate(rec_results):
        print(i, "rec_score:", round(float(item["score"]), 4), "text:", repr(item["text"]))

    print("\n=== recognizer (sentence level) ===")
    sentence_results = recognizer.predict_sentences(crops)
    for i, item in enumerate(sentence_results):
        print(i, "sent_score:", round(float(item["score"]), 4), "text:", repr(item["text"]))

    ocr_vis = draw_ocr_results(image, kept_det_items, rec_results)
    ocr_vis.save(ocr_vis_path)
    print("\nsaved OCR visualization:", ocr_vis_path.resolve())

    with log_path.open("w", encoding="utf-8") as f:
        f.write("=== line level ===\n")
        for i, item in enumerate(rec_results):
            f.write(
                f"{i}\trec_score={float(item['score']):.4f}\ttext={item['text']!r}\n"
            )
        f.write("\n=== sentence level ===\n")
        for i, item in enumerate(sentence_results):
            f.write(
                f"{i}\tsent_score={float(item['score']):.4f}\tparts={int(item.get('parts', 0))}\ttext={item['text']!r}\n"
            )

    print("saved OCR text log:", log_path.resolve())


if __name__ == "__main__":
    main()

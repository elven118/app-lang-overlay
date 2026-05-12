from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import cv2
import mss
import numpy as np
from PIL import Image

from ..config import get_ocr_lang, profile_path, try_load_capture_region
from ..ocr import _crop_rotated_text_region
from ..text_det import OnnxTextDetector
from ..text_rec import OnnxTextRecognizer


def _draw_det_boxes(image: Image.Image, results: list[dict]) -> Image.Image:
    img = np.array(image.convert("RGB")).copy()
    for item in results:
        box = item["box"].astype(np.int32)
        score = float(item["score"])
        cv2.polylines(img, [box], isClosed=True, color=(0, 255, 0), thickness=2)
        x, y = box[0]
        cv2.putText(
            img,
            f"{score:.2f}",
            (int(x), max(15, int(y) - 5)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            (255, 0, 0),
            1,
            cv2.LINE_AA,
        )
    return Image.fromarray(img)


def _draw_ocr_boxes(
    image: Image.Image,
    det_items: list[dict],
    rec_items: list[dict],
) -> Image.Image:
    img = np.array(image.convert("RGB")).copy()
    for idx, (det_item, rec_item) in enumerate(zip(det_items, rec_items)):
        box = det_item["box"].astype(np.int32)
        text = str(rec_item.get("text", ""))
        rec_score = float(rec_item.get("score", 0.0))
        det_score = float(det_item.get("score", 0.0))
        cv2.polylines(img, [box], isClosed=True, color=(0, 255, 0), thickness=2)
        x, y = box[0]
        label = f"{idx}: {text} ({rec_score:.2f}/{det_score:.2f})"
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
    parser = argparse.ArgumentParser(description="Capture-area OCR debug flow")
    parser.add_argument("--game", default="demo", help="profile id in data/profiles/<game>.json")
    parser.add_argument("--lang", default="", help="recognizer lang override (default: profile/runtime)")
    parser.add_argument("--min-det-score", type=float, default=0.5, help="min det score for crop/rec")
    parser.add_argument("--left", type=int, default=None, help="manual capture left")
    parser.add_argument("--top", type=int, default=None, help="manual capture top")
    parser.add_argument("--width", type=int, default=None, help="manual capture width")
    parser.add_argument("--height", type=int, default=None, help="manual capture height")
    parser.add_argument(
        "--out-dir",
        default="app_lang_overlay/test/capture_debug",
        help="output base folder",
    )
    args = parser.parse_args()

    p = profile_path(args.game)
    profile = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}

    region_candidates: list[dict] = []
    region_primary = try_load_capture_region(args.game)
    if region_primary is not None:
        region_candidates.append(region_primary)

    overlay_region = (
        profile.get("overlay_settings", {}).get("captureRegion")
        if isinstance(profile, dict)
        else None
    )
    if isinstance(overlay_region, dict):
        candidate = {
            "left": int(overlay_region.get("left", 0)),
            "top": int(overlay_region.get("top", 0)),
            "width": int(overlay_region.get("width", 0)),
            "height": int(overlay_region.get("height", 0)),
        }
        if candidate["width"] > 0 and candidate["height"] > 0:
            region_candidates.append(candidate)

    manual_args = (args.left, args.top, args.width, args.height)
    if all(v is not None for v in manual_args):
        region_candidates.insert(
            0,
            {
                "left": int(args.left),
                "top": int(args.top),
                "width": int(args.width),
                "height": int(args.height),
            },
        )

    if not region_candidates:
        raise RuntimeError(f"capture region missing for profile={args.game}: {p}")

    lang = (args.lang or get_ocr_lang(args.game, default_lang="en")).strip() or "en"
    ts = time.strftime("%Y%m%d_%H%M%S")
    out_root = Path(args.out_dir) / f"{args.game}_{ts}"
    crops_dir = out_root / "crops"
    out_root.mkdir(parents=True, exist_ok=True)
    crops_dir.mkdir(parents=True, exist_ok=True)

    print("=== capture ===")
    print("profile:", args.game)
    print("region candidates:", region_candidates)
    print("lang:", lang)
    print("output:", out_root.resolve())

    shot = None
    region = None
    with mss.MSS() as sct:
        print("mss monitors:", sct.monitors)
        for candidate in region_candidates:
            try:
                shot = sct.grab(candidate)
                region = candidate
                break
            except Exception as exc:
                print("capture failed for region:", candidate, "error:", repr(exc))

    if shot is None or region is None:
        raise RuntimeError("failed to capture with all region candidates")

    print("selected region:", region)

    image = Image.frombytes("RGB", shot.size, shot.rgb)
    image_rgb = np.array(image)
    image_bgr = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR)

    capture_path = out_root / "capture.jpg"
    image.save(capture_path)
    print("saved capture:", capture_path.resolve())

    detector = OnnxTextDetector()
    recognizer = OnnxTextRecognizer(lang=lang)

    print("\n=== detector ===")
    det_results = detector.predict(image)
    print("detected boxes:", len(det_results))
    for i, item in enumerate(det_results[:50]):
        print(i, "det_score:", round(float(item["score"]), 4), "box:", item["box"].tolist())

    det_vis = _draw_det_boxes(image, det_results)
    det_vis_path = out_root / "det_result.jpg"
    det_vis.save(det_vis_path)
    print("saved det result:", det_vis_path.resolve())

    print("\n=== crop ===")
    kept_det_items: list[dict] = []
    crops: list[np.ndarray] = []
    for item in det_results:
        if float(item.get("score", 0.0)) < args.min_det_score:
            continue
        box = item.get("box")
        if not isinstance(box, np.ndarray) or box.shape != (4, 2):
            continue
        crop = _crop_rotated_text_region(image_bgr, box)
        if crop is None:
            continue
        kept_det_items.append(item)
        crops.append(crop)
        cv2.imwrite(str(crops_dir / f"crop_{len(crops)-1:03d}.jpg"), crop)

    print("kept crops:", len(crops))
    print("saved crops dir:", crops_dir.resolve())

    print("\n=== decode (line) ===")
    rec_results = recognizer.predict(crops, as_sentences=False)
    for i, item in enumerate(rec_results):
        print(i, "rec_score:", round(float(item.get("score", 0.0)), 4), "text:", repr(item.get("text", "")))

    print("\n=== decode (sentence) ===")
    sentence_results = recognizer.predict_sentences(crops)
    for i, item in enumerate(sentence_results):
        print(
            i,
            "sent_score:",
            round(float(item.get("score", 0.0)), 4),
            "parts:",
            int(item.get("parts", 0)),
            "text:",
            repr(item.get("text", "")),
        )

    ocr_vis = _draw_ocr_boxes(image, kept_det_items, rec_results)
    ocr_vis_path = out_root / "ocr_result.jpg"
    ocr_vis.save(ocr_vis_path)
    print("saved ocr result:", ocr_vis_path.resolve())

    log_path = out_root / "decode_log.txt"
    with log_path.open("w", encoding="utf-8") as f:
        f.write(f"profile={args.game}\n")
        f.write(f"region={region}\n")
        f.write(f"lang={lang}\n")
        f.write(f"min_det_score={args.min_det_score}\n\n")
        f.write("=== detector ===\n")
        for i, item in enumerate(det_results):
            f.write(
                f"{i}\tdet_score={float(item['score']):.4f}\tbox={item['box'].tolist()}\n"
            )
        f.write("\n=== decode line ===\n")
        for i, item in enumerate(rec_results):
            f.write(
                f"{i}\trec_score={float(item.get('score', 0.0)):.4f}\ttext={item.get('text', '')!r}\n"
            )
        f.write("\n=== decode sentence ===\n")
        for i, item in enumerate(sentence_results):
            f.write(
                f"{i}\tsent_score={float(item.get('score', 0.0)):.4f}\tparts={int(item.get('parts', 0))}\ttext={item.get('text', '')!r}\n"
            )
    print("saved decode log:", log_path.resolve())


if __name__ == "__main__":
    main()

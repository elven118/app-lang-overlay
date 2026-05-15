from __future__ import annotations

import argparse
import asyncio
import json
import time
from collections import OrderedDict
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from ..llm import LocalTranslator
from ..ocr import _extract_text_crops
from ..text_det import OnnxTextDetector
from ..text_rec import OnnxTextRecognizer
from ..textproc import dedupe_key, normalize_for_compare


def _read_truth_segments(path: Path | None) -> list[dict]:
    if path is None or not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    for row in data:
        if not isinstance(row, dict):
            continue
        text = str(row.get("text", "")).strip()
        start = float(row.get("start_s", -1))
        end = float(row.get("end_s", -1))
        if text and start >= 0 and end >= start:
            out.append({"text": text, "start_s": start, "end_s": end})
    return out


def _render_overlay_video(events: list[dict], out_path: Path, duration_s: float) -> bool:
    width, height = 960, 220
    fps = 30
    writer = cv2.VideoWriter(str(out_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    if not writer.isOpened():
        return False

    subtitles = [e for e in events if e.get("type") == "subtitle"]
    hides = [e for e in events if e.get("type") == "subtitle_hide"]
    sub_idx = 0
    hide_idx = 0
    current_source = ""
    current_translated = ""
    font = ImageFont.load_default()

    frames = int(max(duration_s, 0.1) * fps)
    for frame_idx in range(frames):
        t = frame_idx / fps
        while hide_idx < len(hides) and hides[hide_idx]["timestamp_s"] <= t:
            current_source = ""
            current_translated = ""
            hide_idx += 1
        while sub_idx < len(subtitles) and subtitles[sub_idx]["timestamp_s"] <= t:
            item = subtitles[sub_idx]
            current_source = item.get("source_text", "")
            current_translated = item.get("translated_text", "")
            sub_idx += 1

        img = Image.new("RGB", (width, height), (15, 15, 15))
        draw = ImageDraw.Draw(img)
        draw.text((20, 16), f"t={t:05.2f}s", fill=(170, 170, 170), font=font)
        if current_source:
            draw.rectangle((30, 58, width - 30, 178), fill=(35, 35, 35), outline=(80, 200, 100), width=2)
            draw.text((46, 82), current_source, fill=(240, 240, 240), font=font)
            draw.text((46, 124), current_translated or "", fill=(255, 230, 150), font=font)
        else:
            draw.text((46, 104), "(hidden)", fill=(120, 120, 120), font=font)

        frame = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
        writer.write(frame)

    writer.release()
    return True


def _compute_truth_latency(events: list[dict], truth: list[dict]) -> list[dict]:
    subtitles = [e for e in events if e.get("type") == "subtitle"]
    rows: list[dict] = []
    for seg in truth:
        start_s = float(seg["start_s"])
        end_s = float(seg["end_s"])
        text = str(seg["text"])
        first = next(
            (
                e
                for e in subtitles
                if e.get("source_text") == text and start_s - 0.4 <= float(e["timestamp_s"]) <= end_s + 0.6
            ),
            None,
        )
        if first is None:
            rows.append(
                {"text": text, "caption_start_s": start_s, "first_show_s": None, "response_ms": None}
            )
            continue
        first_show = float(first["timestamp_s"])
        rows.append(
            {
                "text": text,
                "caption_start_s": start_s,
                "first_show_s": first_show,
                "response_ms": round((first_show - start_s) * 1000, 1),
            }
        )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Replay a real video through OCR + LLM timing flow")
    parser.add_argument("--video", required=True, help="input video path")
    parser.add_argument("--ocr-lang", default="en", help="recognizer language")
    parser.add_argument("--poll-ms", type=int, default=120, help="sampling interval in ms")
    parser.add_argument("--auto-hide-ms", type=int, default=1400, help="overlay auto hide duration")
    parser.add_argument("--target-lang", default="繁體中文", help="translator target language")
    parser.add_argument("--truth-json", default="", help="optional ground-truth captions json [{start_s,end_s,text}]")
    parser.add_argument(
        "--out-dir",
        default="app_lang_overlay/test/live_ocr_replay_debug",
        help="artifact output base directory",
    )
    args = parser.parse_args()

    video_path = Path(args.video).expanduser().resolve()
    if not video_path.exists():
        raise FileNotFoundError(f"video not found: {video_path}")

    ts = time.strftime("%Y%m%d_%H%M%S")
    out_root = Path(args.out_dir) / f"replay_{ts}"
    out_root.mkdir(parents=True, exist_ok=True)

    truth = _read_truth_segments(Path(args.truth_json).expanduser().resolve() if args.truth_json else None)
    detector = OnnxTextDetector()
    recognizer = OnnxTextRecognizer(lang=args.ocr_lang)
    translator = LocalTranslator(target_lang=args.target_lang)

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"failed to open video: {video_path}")

    fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration_s = frame_count / max(fps, 0.001)
    step_frames = max(1, int(round((args.poll_ms / 1000.0) * fps)))

    events: list[dict] = []
    ocr_rows: list[dict] = []
    last_emitted_compare = ""
    blank_since = 0.0
    hide_sent_for_blank = False
    translation_calls: dict[str, int] = {}
    translation_by_key: OrderedDict[str, str] = OrderedDict()
    translation_cache_limit = 64
    overlay_visible = False
    frame_idx = 0

    while True:
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ok, frame_bgr = cap.read()
        if not ok:
            break
        t_s = frame_idx / max(fps, 0.001)
        frame_idx += step_frames

        img_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        pil_img = Image.fromarray(img_rgb)
        det_results = detector.predict(pil_img)
        crops = _extract_text_crops(frame_bgr, det_results)
        text = ""
        if crops:
            sentence_results = recognizer.predict_sentences(crops)
            text = "\n".join(item["text"] for item in sentence_results if item.get("text"))

        compare_text = normalize_for_compare(text)
        ocr_rows.append(
            {
                "timestamp_s": t_s,
                "text": text,
                "compare_text": compare_text,
                "det_box_count": len(det_results),
                "crop_count": len(crops),
            }
        )

        if not text:
            if blank_since == 0.0:
                blank_since = t_s
            hide_timeout_s = max(args.poll_ms + max(args.auto_hide_ms, 0), 0) / 1000.0
            if (
                args.auto_hide_ms >= 0
                and overlay_visible
                and not hide_sent_for_blank
                and t_s - blank_since >= hide_timeout_s
            ):
                hide_sent_for_blank = True
                overlay_visible = False
                events.append({"type": "subtitle_hide", "timestamp_s": t_s, "reason": "no_text_timeout"})
                last_emitted_compare = ""
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
            translated = asyncio.run(translator.translate(text))
            translation_by_key[source_key] = translated
            if len(translation_by_key) > translation_cache_limit:
                translation_by_key.popitem(last=False)
            translation_calls[text] = translation_calls.get(text, 0) + 1

        overlay_visible = True
        events.append(
            {
                "type": "subtitle",
                "timestamp_s": t_s,
                "source_text": text,
                "translated_text": translated,
                "dedupe_key": source_key,
                "hide_after_ms": -1,
            }
        )

    cap.release()
    events.append({"type": "translation_stats", "calls": translation_calls})

    lat_rows = _compute_truth_latency(events, truth) if truth else []
    summary = {
        "video": str(video_path),
        "fps": fps,
        "duration_s": duration_s,
        "poll_ms": args.poll_ms,
        "auto_hide_ms": args.auto_hide_ms,
        "ocr_lang": args.ocr_lang,
        "target_lang": args.target_lang,
        "subtitle_event_count": len([e for e in events if e.get("type") == "subtitle"]),
        "subtitle_hide_event_count": len([e for e in events if e.get("type") == "subtitle_hide"]),
        "translation_calls": translation_calls,
        "latency_rows": lat_rows,
    }

    events_path = out_root / "overlay_events.json"
    ocr_path = out_root / "ocr_samples.json"
    metrics_path = out_root / "metrics.json"
    video_out = out_root / "overlay_replay.mp4"
    report_path = out_root / "report.txt"

    events_path.write_text(json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")
    ocr_path.write_text(json.dumps(ocr_rows, ensure_ascii=False, indent=2), encoding="utf-8")
    metrics_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    video_ok = _render_overlay_video(events, video_out, duration_s)

    report_lines = [
        f"output={out_root.resolve()}",
        f"video={video_path}",
        f"fps={fps:.3f}",
        f"duration_s={duration_s:.3f}",
        f"poll_ms={args.poll_ms}",
        f"subtitle_event_count={summary['subtitle_event_count']}",
        f"subtitle_hide_event_count={summary['subtitle_hide_event_count']}",
        f"translation_calls={translation_calls}",
        f"video_generated={video_ok}",
    ]
    if lat_rows:
        report_lines.append("latency_rows:")
        for row in lat_rows:
            report_lines.append(
                f"  text={row['text']!r} caption_start_s={row['caption_start_s']} first_show_s={row['first_show_s']} response_ms={row['response_ms']}"
            )

    report_path.write_text("\n".join(report_lines) + "\n", encoding="utf-8")
    print(report_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()

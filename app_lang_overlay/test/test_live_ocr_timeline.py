from __future__ import annotations

import argparse
import json
import math
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from ..textproc import normalize_for_compare

try:
    import cv2  # type: ignore
except Exception:
    cv2 = None


@dataclass(frozen=True)
class CaptionSegment:
    start_s: float
    end_s: float
    text: str


@dataclass(frozen=True)
class OcrSample:
    timestamp_s: float
    text: str


def _build_ground_truth() -> list[CaptionSegment]:
    return [
        CaptionSegment(0.50, 2.40, "Hello, world!"),
        CaptionSegment(3.20, 4.80, "How are you?"),
        CaptionSegment(6.30, 7.00, "How are you?"),  # same text reappears after clear interval
        CaptionSegment(7.80, 9.00, "Are you ready?"),
    ]


def _build_ocr_samples(
    truth: list[CaptionSegment],
    poll_ms: int,
    jitter_s: float = 0.04,
) -> list[OcrSample]:
    end_s = max(item.end_s for item in truth) + 2.0
    step_s = max(poll_ms, 50) / 1000.0
    rng = np.random.default_rng(42)

    samples: list[OcrSample] = []
    t = 0.0
    while t <= end_s:
        text = ""
        for seg in truth:
            if seg.start_s <= t <= seg.end_s:
                text = seg.text
                break
        if text:
            # Simulate OCR instability near edges.
            near_edge = any(
                abs(t - seg.start_s) < 0.2 or abs(t - seg.end_s) < 0.2
                for seg in truth
                if seg.text == text and seg.start_s <= t <= seg.end_s
            )
            if near_edge and rng.random() < 0.25:
                text = ""
        t_noise = float(t + rng.uniform(-jitter_s, jitter_s))
        samples.append(OcrSample(max(t_noise, 0.0), text))
        t += step_s

    samples.sort(key=lambda x: x.timestamp_s)
    return samples


def _simulate_overlay_events(
    samples: list[OcrSample],
    auto_hide_ms: int,
    clear_after_s: float = 1.0,
) -> list[dict]:
    events: list[dict] = []
    last_emitted_compare = ""
    last_translated_compare = ""
    blank_since = 0.0
    current_visible_text = ""
    visible_until = 0.0
    translated_calls: dict[str, int] = {}

    def fake_translate(text: str) -> str:
        translated_calls[text] = translated_calls.get(text, 0) + 1
        return f"ZH:{text}"

    for sample in samples:
        now = sample.timestamp_s
        text = sample.text
        compare_text = normalize_for_compare(text)

        if current_visible_text and now > visible_until:
            events.append({"type": "clear", "timestamp_s": now, "reason": "autohide"})
            current_visible_text = ""

        if not text:
            if blank_since == 0.0:
                blank_since = now
            if now - blank_since >= clear_after_s:
                if current_visible_text:
                    events.append({"type": "clear", "timestamp_s": now, "reason": "empty_ocr"})
                    current_visible_text = ""
                last_emitted_compare = ""
            continue

        blank_since = 0.0

        if compare_text == last_emitted_compare:
            continue

        last_emitted_compare = compare_text
        if compare_text != last_translated_compare:
            translated = fake_translate(text)
            last_translated_compare = compare_text
        else:
            translated = f"ZH:{text}"

        visible_until = now + (auto_hide_ms / 1000.0)
        current_visible_text = text
        events.append(
            {
                "type": "subtitle",
                "timestamp_s": now,
                "source_text": text,
                "translated_text": translated,
                "visible_until_s": visible_until,
            }
        )

    events.append({"type": "translation_stats", "calls": translated_calls})
    return events


def _compute_metrics(truth: list[CaptionSegment], events: list[dict]) -> dict:
    subtitle_events = [e for e in events if e.get("type") == "subtitle"]
    clear_events = [e for e in events if e.get("type") == "clear"]
    translation_stats = next(e for e in events if e.get("type") == "translation_stats")

    response_rows: list[dict] = []
    for seg in truth:
        first = next(
            (
                e
                for e in subtitle_events
                if e["source_text"] == seg.text and e["timestamp_s"] >= seg.start_s - 0.35
            ),
            None,
        )
        if first is None:
            response_rows.append(
                {
                    "text": seg.text,
                    "caption_start_s": seg.start_s,
                    "first_show_s": None,
                    "response_ms": None,
                }
            )
            continue
        response_rows.append(
            {
                "text": seg.text,
                "caption_start_s": seg.start_s,
                "first_show_s": first["timestamp_s"],
                "response_ms": round((first["timestamp_s"] - seg.start_s) * 1000, 1),
            }
        )

    return {
        "subtitle_event_count": len(subtitle_events),
        "clear_event_count": len(clear_events),
        "translation_calls": translation_stats["calls"],
        "response_rows": response_rows,
    }


def _draw_timeline(
    truth: list[CaptionSegment],
    events: list[dict],
    out_path: Path,
    width: int = 1400,
    height: int = 460,
) -> None:
    margin = 70
    img = Image.new("RGB", (width, height), (20, 20, 20))
    draw = ImageDraw.Draw(img)
    font_title = ImageFont.load_default()
    font_text = ImageFont.load_default()
    duration_s = max(seg.end_s for seg in truth) + 2.0
    lane_truth_y = 130
    lane_overlay_y = 300

    def x_for_t(t: float) -> int:
        span = max(duration_s, 0.001)
        return margin + int((width - margin * 2) * (t / span))

    draw.text((margin, 40), "Live OCR Timeline", fill=(240, 240, 240), font=font_title)
    draw.text((margin, lane_truth_y - 35), "Ground Truth Captions", fill=(180, 220, 255), font=font_text)
    draw.text((margin, lane_overlay_y - 35), "Overlay Events", fill=(180, 255, 180), font=font_text)

    draw.line((margin, lane_truth_y, width - margin, lane_truth_y), fill=(60, 60, 60), width=1)
    draw.line((margin, lane_overlay_y, width - margin, lane_overlay_y), fill=(60, 60, 60), width=1)

    for seg in truth:
        x1 = x_for_t(seg.start_s)
        x2 = x_for_t(seg.end_s)
        draw.rectangle((x1, lane_truth_y - 18, x2, lane_truth_y + 18), fill=(80, 150, 220))
        draw.text((x1 + 4, lane_truth_y - 34), seg.text[:14], fill=(220, 220, 220), font=font_text)

    for event in events:
        kind = event.get("type")
        if kind == "subtitle":
            x = x_for_t(float(event["timestamp_s"]))
            draw.ellipse((x - 7, lane_overlay_y - 7, x + 7, lane_overlay_y + 7), fill=(80, 220, 120))
            draw.text((x + 8, lane_overlay_y - 18), event["source_text"][:14], fill=(200, 255, 200), font=font_text)
        elif kind == "clear":
            x = x_for_t(float(event["timestamp_s"]))
            draw.ellipse((x - 6, lane_overlay_y - 6, x + 6, lane_overlay_y + 6), fill=(80, 80, 240))
            draw.text((x + 8, lane_overlay_y + 8), "clear", fill=(180, 180, 255), font=font_text)

    for sec in np.arange(0.0, math.ceil(duration_s) + 0.001, 1.0):
        x = x_for_t(float(sec))
        draw.line((x, height - 45, x, height - 30), fill=(140, 140, 140), width=1)
        draw.text((x - 12, height - 20), f"{sec:.0f}s", fill=(180, 180, 180), font=font_text)

    img.save(out_path)


def _write_video(events: list[dict], out_path: Path, duration_s: float) -> bool:
    if cv2 is None:
        return False
    width, height = 960, 220
    fps = 30
    writer = cv2.VideoWriter(
        str(out_path),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height),
    )
    if not writer.isOpened():
        return False

    subtitle_events = [e for e in events if e.get("type") == "subtitle"]
    clear_events = [e for e in events if e.get("type") == "clear"]
    event_idx = 0
    clear_idx = 0
    visible_text = ""
    visible_until = -1.0

    frames = int(duration_s * fps)
    font = ImageFont.load_default()
    for i in range(frames):
        t = i / fps
        while clear_idx < len(clear_events) and clear_events[clear_idx]["timestamp_s"] <= t:
            visible_text = ""
            visible_until = -1.0
            clear_idx += 1
        while event_idx < len(subtitle_events) and subtitle_events[event_idx]["timestamp_s"] <= t:
            evt = subtitle_events[event_idx]
            visible_text = evt["source_text"]
            visible_until = evt["visible_until_s"]
            event_idx += 1
        if visible_text and t > visible_until:
            visible_text = ""
            visible_until = -1.0

        pil_img = Image.new("RGB", (width, height), (14, 14, 14))
        draw = ImageDraw.Draw(pil_img)
        # draw.text((20, 20), f"t={t:05.2f}s", fill=(180, 180, 180), font=font)
        if visible_text:
            draw.rectangle((30, 70, width - 30, 170), fill=(35, 35, 35), outline=(90, 200, 90), width=2)
            draw.text((45, 110), visible_text, fill=(240, 240, 240), font=font)
        # else:
        #     draw.text((45, 110), "(hidden)", fill=(120, 120, 120), font=font)
        frame = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
        writer.write(frame)
    writer.release()
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Live OCR timeline simulation and visualization")
    parser.add_argument("--poll-ms", type=int, default=120, help="OCR poll interval simulation")
    parser.add_argument("--auto-hide-ms", type=int, default=1400, help="overlay auto hide duration")
    parser.add_argument("--out-dir", default="app_lang_overlay/test/live_ocr_debug", help="artifact output directory")
    args = parser.parse_args()

    ts = time.strftime("%Y%m%d_%H%M%S")
    out_root = Path(args.out_dir) / f"sim_{ts}"
    out_root.mkdir(parents=True, exist_ok=True)

    truth = _build_ground_truth()
    samples = _build_ocr_samples(truth, poll_ms=args.poll_ms)
    events = _simulate_overlay_events(samples, auto_hide_ms=args.auto_hide_ms)
    metrics = _compute_metrics(truth, events)

    # Assertions for required behavior:
    # 1) Same text reappears and overlays again.
    # 2) Reappeared same text does not trigger second translation.
    # 3) New text appears immediately as replacement event.
    # 4) Overlay clears when no text is present long enough.
    subtitles = [e for e in events if e.get("type") == "subtitle"]
    clears = [e for e in events if e.get("type") == "clear"]
    repeat_text = "How are you?"
    repeat_events = [e for e in subtitles if e["source_text"] == repeat_text]
    assert len(repeat_events) >= 2, "Expected repeated subtitle to pop up again after blank interval"
    assert metrics["translation_calls"].get(repeat_text, 0) == 1, "Expected no re-translation for repeated same text"
    assert len(clears) >= 1, "Expected at least one clear event after no-text interval"

    timeline_path = out_root / "timeline.png"
    _draw_timeline(truth, events, timeline_path)

    duration_s = max(seg.end_s for seg in truth) + 2.0
    video_path = out_root / "overlay_sim.mp4"
    video_ok = _write_video(events, video_path, duration_s=duration_s)

    samples_path = out_root / "ocr_samples.json"
    events_path = out_root / "overlay_events.json"
    metrics_path = out_root / "metrics.json"
    samples_path.write_text(
        json.dumps([sample.__dict__ for sample in samples], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    events_path.write_text(json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")
    metrics_path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")

    report_lines = [
        f"output={out_root.resolve()}",
        f"poll_ms={args.poll_ms}",
        f"auto_hide_ms={args.auto_hide_ms}",
        f"subtitle_event_count={metrics['subtitle_event_count']}",
        f"clear_event_count={metrics['clear_event_count']}",
        f"translation_calls={metrics['translation_calls']}",
        "response_rows:",
    ]
    for row in metrics["response_rows"]:
        report_lines.append(
            f"  text={row['text']!r} caption_start_s={row['caption_start_s']:.2f} first_show_s={row['first_show_s']} response_ms={row['response_ms']}"
        )
    report_lines.append(f"video_generated={video_ok}")

    report_path = out_root / "report.txt"
    report_path.write_text("\n".join(report_lines) + "\n", encoding="utf-8")
    print(report_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()

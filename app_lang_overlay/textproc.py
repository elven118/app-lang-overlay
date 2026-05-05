from __future__ import annotations

import hashlib
import re


def normalize_text(text: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    normalized = "\n".join(line.strip() for line in normalized.split("\n"))
    normalized = re.sub(r"\n{2,}", "\n", normalized)
    normalized = re.sub(r"[ \t]{2,}", " ", normalized)
    return normalized.strip()


def normalize_for_compare(text: str) -> str:
    reduced = normalize_text(text).lower()
    reduced = re.sub(r"[^\w\s\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]", "", reduced)
    reduced = re.sub(r"\s+", " ", reduced).strip()
    return reduced


def confidence_for_text(text: str) -> float:
    if not text:
        return 0.0
    alpha = sum(1 for ch in text if ch.isalnum())
    ratio = alpha / max(len(text), 1)
    return round(min(max(ratio, 0.2), 0.99), 2)


def dedupe_key(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]

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

def dedupe_key(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]

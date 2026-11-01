import pykakasi

from ..domain import SourceReadingSegment


_CONVERTER = pykakasi.kakasi()


def _hiragana(character: str) -> str:
    codepoint = ord(character)
    if 0x30A1 <= codepoint <= 0x30F6:
        return chr(codepoint - 0x60)
    return character


def _is_kana(character: str) -> bool:
    codepoint = ord(character)
    return 0x3040 <= codepoint <= 0x30FF


def _append(segments: list[SourceReadingSegment], text: str, reading: str | None) -> None:
    if not text:
        return
    if segments and segments[-1].reading == reading:
        previous = segments[-1]
        segments[-1] = SourceReadingSegment(previous.text + text, reading)
    else:
        segments.append(SourceReadingSegment(text, reading))


def source_reading_segments(text: str) -> list[SourceReadingSegment]:
    segments: list[SourceReadingSegment] = []
    for item in _CONVERTER.convert(text):
        original = str(item["orig"])
        hiragana = str(item["hira"])
        katakana = str(item["kana"])
        if original == hiragana or original == katakana:
            _append(segments, original, None)
            continue

        prefix_length = 0
        while (
            prefix_length < len(original)
            and prefix_length < len(hiragana)
            and _is_kana(original[prefix_length])
            and _hiragana(original[prefix_length]) == hiragana[prefix_length]
        ):
            prefix_length += 1

        suffix_length = 0
        while (
            suffix_length < len(original) - prefix_length
            and suffix_length < len(hiragana) - prefix_length
            and _is_kana(original[-(suffix_length + 1)])
            and _hiragana(original[-(suffix_length + 1)]) == hiragana[-(suffix_length + 1)]
        ):
            suffix_length += 1

        core_end = len(original) - suffix_length if suffix_length else len(original)
        reading_end = len(hiragana) - suffix_length if suffix_length else len(hiragana)
        prefix = original[:prefix_length]
        core = original[prefix_length:core_end]
        suffix = original[core_end:]
        core_reading = hiragana[prefix_length:reading_end] or None
        _append(segments, prefix, None)
        _append(segments, core, core_reading)
        _append(segments, suffix, None)
    return segments

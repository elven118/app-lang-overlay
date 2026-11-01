from __future__ import annotations

from ..domain import TextBlock


class LayoutAnalyzer:
    """Apply deterministic horizontal or vertical reading order."""

    @staticmethod
    def order(blocks: list[TextBlock], source_language: str) -> list[TextBlock]:
        if not blocks:
            return []
        cjk = source_language in {"ja", "zh-Hans", "zh-Hant", "auto"}
        vertical_count = sum(1 for item in blocks if item.bounds.height > item.bounds.width * 1.35)
        is_vertical = cjk and vertical_count > len(blocks) / 2
        if is_vertical:
            sorted_blocks = sorted(blocks, key=lambda item: (-item.bounds.x, item.bounds.y))
        else:
            sorted_blocks = sorted(blocks, key=lambda item: (item.bounds.y, item.bounds.x))
        return [
            TextBlock(item.id, item.text, item.confidence, item.bounds, index)
            for index, item in enumerate(sorted_blocks)
        ]

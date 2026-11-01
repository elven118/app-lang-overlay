from overlay_backend.domain import TextBlock


class StubTranslationProvider:
    revision = "test-stub-v1"

    async def translate_blocks(
        self,
        blocks: list[TextBlock],
        source_language: str,
        target_language: str,
    ) -> dict[str, str]:
        return {item.id: f"[{target_language}] {item.text}" for item in blocks}

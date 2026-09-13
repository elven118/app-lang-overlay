TARGET_LANGUAGE_MAP = {
    "en": "English",
    "ja": "日本語",
    "zh-Hant": "繁體中文",
    "zh-Hans": "简体中文",
}

def target_language_name(language: str) -> str:
    return TARGET_LANGUAGE_MAP[language]

# app-lang-overlay

Bilingual subtitle overlay for language learning:
- Top line: original subtitle text
- Bottom line: translated subtitle text

Architecture:
- Python backend (`overlay-backend`): OCR/file/stdin ingestion + dedupe + local LLM translation + WebSocket events
- Electron frontend (TypeScript + ES2022): transparent always-on-top overlay window

## Event Contract (V1)

WebSocket payloads from backend to overlay:

`subtitle` event:

```json
{
  "type": "subtitle",
  "profile": "demo",
  "timestamp": 1770000000.25,
  "source_text": "おはよう。",
  "translated_text": "Good morning.",
  "lang_src": "ja",
  "lang_dst": "en",
  "confidence": 0.95,
  "dedupe_key": "おはよう。:Good morning.",
  "hide_after_ms": 2200
}
```

`clear` event:

```json
{
  "type": "clear",
  "profile": "demo",
  "timestamp": 1770000002.0,
  "reason": "timeout"
}
```

## 1) Run Electron overlay

```bash
cd electron
npm install
npm run overlay
```

## 2) One-command dev mode (backend + overlay)

```bash
cd electron
npm run dev
```

`npm run dev` starts:
- Python OCR subtitle backend on localhost WebSocket
- Electron overlay window (renders 2-line subtitles)
- Global picker shortcut: `Cmd/Ctrl + Shift + R`

Profile flow:
1. Select profile by `GAME_ID` (or default `demo`).
2. If profile file does not exist, it is auto-created.
3. If capture region is missing, picker opens automatically.
4. OCR backend waits in standby and starts streaming immediately after region is saved.

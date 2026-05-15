# app-lang-overlay

Bilingual subtitle overlay for language learning:
- Top line: original subtitle text
- Bottom line: translated subtitle text

Architecture:
- `app_lang_overlay`: Python backend (OCR/accessibility ingestion + dedupe + translation + WebSocket events)
- `electron`: Electron frontend overlay (always-on-top transparent window)
- `services/llm_server`: standalone remote LLM translation service (HTTP)

## Big-Tech Style Project Layout

```text
app-lang-overlay/
  app_lang_overlay/         # core backend domain logic
  electron/                 # frontend app
  services/
    llm_server/             # deployable translation service
  scripts/                  # operational entrypoints
  config/                   # runtime config
  data/                     # runtime state (profiles)
  models/                   # local model artifacts
```

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
  "dedupe_key": "おはよう。:Good morning.",
  "hide_after_ms": 2200
}
```

## 1) Run Electron overlay only

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

## 3) Run standalone LLM server on another PC

On the high-end PC:

```bash
python -m services.llm_server.server --host 0.0.0.0 --port 8790 --model-path ./models/HY-MT1.5-7B-Q4_K_M.gguf
```

Optional API key:

```bash
python -m services.llm_server.server --host 0.0.0.0 --port 8790 --model-path ./models/HY-MT1.5-7B-Q4_K_M.gguf --api-key YOUR_SECRET
```

Endpoints:
- `GET /health`
- `POST /translate`

`POST /translate` request body:

```json
{
  "text": "おはよう。",
  "target_lang": "English"
}
```

## 4) Connect local backend to remote LLM server

Set `config/runtime.json` on your overlay PC:

```json
{
  "llm": {
    "mode": "remote",
    "remote_url": "http://HIGH_END_PC_IP:8790/translate",
    "remote_api_key": "",
    "remote_timeout_s": 20,
    "max_tokens": 512
  },
  "overlay": {
    "input_mode": "ocr",
    "poll_ms": 200
  }
}
```

To stay fully local on stronger PCs, switch back:

```json
"llm": {
  "mode": "local",
  "model_path": "./models/HY-MT1.5-7B-Q4_K_M.gguf"
}
```

# app-lang-overlay

Cross-platform OCR translation overlay for books, articles, manga, and games.

Architecture:
- `services/backend`: Python ONNX OCR and translation backend
- `apps/desktop`: Electron frontend overlay (always-on-top transparent window)
- `apps/ios`: iPhone/iPad client project

## Big-Tech Style Project Layout

```text
app-lang-overlay/
  apps/
    desktop/                # Electron frontend
    ios/                    # iOS app
  services/
    backend/                # ONNX OCR, translation, and WebSocket service
      src/overlay_backend/  # Python package
      resources/ocr/        # OCR dictionaries
      tests/                # backend tests and diagnostic tools
  shared/protocol/v1/       # approved cross-platform protocol schema
  config/                   # runtime config
  data/                     # runtime state (profiles)
  models/                   # local model artifacts
```

## Protocol V1

The backend listens at `/v1/stream`. The canonical contract is
`shared/protocol/v1/messages.schema.json`, with examples under
`shared/protocol/v1/fixtures`.

Clients submit device OCR with `frame.text` or an `ALO1` binary JPEG envelope
with a `frame.image` header. The backend returns `translation.result` and
`translation.clear` messages independently for each `regionId`.

## Run the backend

```bash
PYTHONPATH=services/backend/src python -m overlay_backend
```

The default endpoint is `ws://127.0.0.1:8765/v1/stream`. A bearer token is
required when binding outside loopback, and an insecure LAN listener must also
be explicitly enabled.

## Run Electron overlay only

```bash
cd apps/desktop
npm install
npm run overlay
```

## Development launcher

```bash
cd apps/desktop
npm run dev
```

The desktop client protocol migration follows the backend phase.

## Run standalone LLM server on another PC

On the high-end PC:

```bash
PYTHONPATH=services/backend/src python -m overlay_backend.translation_server --host 0.0.0.0 --port 8790 --model-path ./models/HY-MT1.5-7B-Q4_K_M.gguf
```

Optional API key:

```bash
PYTHONPATH=services/backend/src python -m overlay_backend.translation_server --host 0.0.0.0 --port 8790 --model-path ./models/HY-MT1.5-7B-Q4_K_M.gguf --api-key YOUR_SECRET
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

## Connect the backend to a remote LLM server

Set `config/runtime.json` on your overlay PC:

```json
{
  "llm": {
    "mode": "remote",
    "remote_url": "http://HIGH_END_PC_IP:8790/translate",
    "remote_api_key": "",
    "max_tokens": 512
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

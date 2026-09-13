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
    desktop/                # Electron frontend and its local .env
    ios/                    # iOS app
  services/
    backend/                # Backend service and its local .env
      src/overlay_backend/  # Python package
      resources/ocr/        # OCR dictionaries
      tests/                # backend tests and diagnostic tools
  shared/protocol/v1/       # approved cross-platform protocol schema
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

Backend configuration is loaded from `services/backend/.env`. Copy
`services/backend/.env.example` when creating a new development environment.

## Run Electron overlay only

```bash
cd apps/desktop
npm install
npm run overlay
```

Desktop connection defaults are loaded from `apps/desktop/.env`. Copy
`apps/desktop/.env.example` on a new machine.

## Development launcher

```bash
cd apps/desktop
npm run dev
```

The Electron main process owns screen capture and the `/v1/stream` connection.
It sends cropped JPEG frames to server ONNX OCR and forwards typed translation
results to the overlay and transcript through IPC; renderers never connect to
the backend directly.

Desktop capture settings are stored per profile:

- `mode`: `full_screen`, `one_large_area`, or `multiple_regions`
- `polling_ms`: capture polling interval in milliseconds (minimum 100)

In `multiple_regions` mode, each additional use of **Pick Capture Region** adds
another region. Pause/resume is available from the control window and app menu.

Profiles are stored as `data/profiles/<profile>.json`. The control window can
create, load, and rename profiles without restarting Electron. The active
profile is restored on the next launch; `OVERLAY_DEFAULT_PROFILE` can override
it for a specific launch.

## Connect the backend to an external translation API

Remote mode sends a `POST` request containing:

```json
{
  "text": "おはよう。",
  "source_lang": "ja",
  "target_lang": "en"
}
```

The API must return the translated text in `translated_text`, `translatedText`,
or `text`:

```json
{
  "translated_text": "Good morning."
}
```

Configure the external provider in `services/backend/.env`:

```dotenv
OVERLAY_LLM_MODE=remote
OVERLAY_LLM_REMOTE_URL=https://translator.example.com/translate
OVERLAY_LLM_REMOTE_API_KEY=
```

To stay fully local on stronger PCs, switch back:

```dotenv
OVERLAY_LLM_MODE=local
OVERLAY_LLM_MODEL_PATH=./models/HY-MT1.5-7B-Q4_K_M.gguf
```

# app-lang-overlay

OCR translation overlay for books, articles, manga, and games.
See the [design document](docs/app_lang_overlay_design.md) for architecture and implementation details.

## Setup

Run these commands from the repository root on macOS/Linux. Python 3.11+ and
Node.js with Yarn or npm are required. Desktop tests use Node's built-in
TypeScript loading (Node 22.18+).
On macOS, install Xcode Command Line Tools (`xcode-select --install`) to build
the native window picker and capture helpers. Hover window selection currently
supports macOS. Area capture with overlay exclusion requires macOS 14+.
Windows overlays use capture exclusion supported on Windows 10 version 2004+
and Windows 11; the Windows behavior still needs device verification.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e services/backend
(cd apps/desktop && yarn install)
```

Create local configuration files if they do not already exist:

```bash
cp -n services/backend/.env.example services/backend/.env
cp -n apps/desktop/.env.example apps/desktop/.env
```

Both actual `.env` files are ignored by Git. Existing shell environment variables
take precedence. Restart the app/backend after changing configuration.

Provide the ONNX models used by your source languages:

| File under `models/` | Use |
|---|---|
| `det_onnx/PP-OCRv5_server_det.onnx` | Text detection |
| `rec_onnx/PP-OCRv5_rec.onnx` | General CJK recognition and fallback |
| `rec_onnx/en_PP-OCRv5_mobile_rec.onnx` | English recognition |
| `rec_onnx/korean_PP-OCRv5_mobile_rec.onnx` | Korean recognition |

OCR dictionaries are included under `services/backend/resources/ocr/dicts/`.
Local translation also requires a GGUF model; remote translation does not.

## Backend configuration

Edit [services/backend/.env.example](services/backend/.env.example)'s local copy,
`services/backend/.env`.

| Variable | Setting |
|---|---|
| `OVERLAY_BACKEND_HOST` | Bind address; default `127.0.0.1` |
| `OVERLAY_BACKEND_PORT` | WebSocket port; default `8765` |
| `OVERLAY_BACKEND_API_TOKEN` | Bearer token; required outside loopback |
| `OVERLAY_ALLOW_INSECURE_LAN` | Set to `1` to allow a non-loopback `ws://` listener |
| `OVERLAY_LLM_MODE` | `local`, `remote` or `groq` |
| `OVERLAY_LLM_MODEL_PATH` | Local GGUF file; absolute or relative to the repository root |
| `OVERLAY_LLM_REMOTE_URL` | External translation API URL |
| `OVERLAY_LLM_REMOTE_API_KEY` | External API bearer token |
| `GROQ_API_KEY` | Groq API key; required in `groq` mode |
| `OVERLAY_LLM_GROQ_MODEL` | Groq model; default `llama-3.3-70b-versatile` |
| `OVERLAY_LLM_MAX_TOKENS` | Maximum generated tokens; template value `1024` |
| `OVERLAY_LLM_N_CTX` | Context size; template value `4096` |
| `OVERLAY_LLM_N_GPU_LAYERS` | GPU layers; template value `-1` |
| `OVERLAY_LLM_N_THREADS` | CPU threads; template value `8` |
| `OVERLAY_LLM_N_BATCH` | Batch size; template value `1024` |
| `OVERLAY_LLM_CHAT_FORMAT` | Optional llama.cpp chat-format setting |

For local translation:

```dotenv
OVERLAY_LLM_MODE=local
OVERLAY_LLM_MODEL_PATH=./models/HY-MT1.5-7B-Q4_K_M.gguf
```

For an external translation API:

```dotenv
OVERLAY_LLM_MODE=remote
OVERLAY_LLM_REMOTE_URL=https://translator.example.com/translate
OVERLAY_LLM_REMOTE_API_KEY=
```

The external service must implement the
[translation API contract](docs/app_lang_overlay_design.md#external-translation-api).

For Groq translation, install the updated backend dependencies with
`python -m pip install -e services/backend`, then set these values in
`services/backend/.env` or your shell environment:

```dotenv
OVERLAY_LLM_MODE=groq
GROQ_API_KEY=your-api-key-here
OVERLAY_LLM_GROQ_MODEL=llama-3.3-70b-versatile
```

Groq mode sends each OCR text block to Groq's chat completions API and does
not require a local GGUF model. `OVERLAY_LLM_MAX_TOKENS` also controls the Groq
output limit. Restart the backend after changing these settings.

## Desktop configuration

Edit `apps/desktop/.env` using
[apps/desktop/.env.example](apps/desktop/.env.example) as the template.

```dotenv
OVERLAY_BACKEND_URL=ws://127.0.0.1:8765/v1/stream
OVERLAY_BACKEND_TOKEN=
OVERLAY_DEFAULT_PROFILE=
```

The desktop token must match the backend token when authentication is enabled.
Leave `OVERLAY_DEFAULT_PROFILE` empty to restore the last selected profile.
The desktop loads local HTML files; it does not require a frontend HTTP port.

## Run

### Desktop and local backend together

From the repository root:

```bash
cd apps/desktop
yarn dev
```

This builds Electron and starts the local backend using the root `.venv`.
Do not start another backend on the same port. During local development, the
launcher can use the backend token if the desktop token is empty.

### Backend separately

From the repository root:

```bash
source .venv/bin/activate
PYTHONPATH=services/backend/src python -m overlay_backend
```

The default endpoint is `ws://127.0.0.1:8765/v1/stream`.

### Desktop with an existing backend

Set `OVERLAY_BACKEND_URL` and `OVERLAY_BACKEND_TOKEN` in the desktop environment,
then run:

```bash
cd apps/desktop
yarn overlay
```

Use this command when the backend is already running locally or on another machine.
npm equivalents are `npm install`, `npm run dev`, and `npm run overlay`.

## Use the desktop app

1. On macOS, grant Electron Screen & System Audio Recording permission in
   System Settings → Privacy & Security. Restart Electron after changing permission.
2. Click the tray/menu-bar icon to open controls. Controls start hidden.
3. Create or load a profile, then open Overlay Settings to set languages,
   capture mode, and `polling_ms` (100–60,000 ms).
4. For **Selected Window**, use **Choose Window**, hover over the desired window,
   and click its highlighted area. Escape or right-click cancels. Keep the selected
   window open and unminimized. For **One Large Area**, draw a rectangle. For **Multiple Regions**,
   use **Edit Capture Regions**, choose a screen, and draw several rectangles.
   Remove areas with **×**, or use **Undo** / **Clear this screen**. Press **Enter**
   or **Apply regions** to save the set. Escape or right-click discards edits;
   saved areas on other screens are preserved.
5. Use **Pause Capture**, **Show Transcript**, and overlay settings as needed.
   Closing controls hides them; right-click the tray icon and choose **Quit** to exit.

Selected Window requests a new selection after restart/profile switch. Existing
Full Screen profiles open the window chooser on migration. Escape/Cancel keeps
the previous mode when changing to Selected Window.

Profiles are stored in `data/profiles/`. Create, load, and rename them from
controls. Keyboard shortcuts: `CommandOrControl+Shift+R` chooses a capture target,
`CommandOrControl+Shift+P` toggles overlay settings, and
`CommandOrControl+Shift+C` copies the displayed text.

## Verification

From the repository root:

```bash
python -m unittest discover -s services/backend/tests -t services/backend
(cd apps/desktop && yarn test:ipc)
(cd apps/desktop && yarn build)
```

Selected Window also prints temporary `[desktop-ocr-positions]` logs, including
recognized text. See [OCR position coordinates](docs/app_lang_overlay_design.md#ocr-position-coordinates)
for their meaning.

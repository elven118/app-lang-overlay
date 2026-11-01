# App Lang Overlay design

OCR translation overlay for books, articles, manga, and games. This document
describes the current desktop/backend implementation and its design boundaries.
For installation, environment values, startup commands, and operating procedures,
see [README](../README.md).

## Scope and repository layout

The desktop client uses Electron, and the shared Python backend owns ONNX OCR
and translation. The protocol also defines iOS and Android client kinds; mobile
client implementation is outside the desktop design described here.

```text
app-lang-overlay/
├── apps/desktop/
│   ├── src/main.ts
│   ├── src/main/           # Capture, streams, backend client, profiles, tray
│   ├── src/preload/        # Restricted renderer IPC bridges
│   ├── src/renderer/       # Visible views and hidden media worker
│   ├── native/             # macOS metadata and filtered capture helpers
│   └── .env.example
├── services/backend/
│   ├── src/overlay_backend/
│   │   ├── api/            # WebSocket gateway, framing, validation
│   │   ├── config/         # Paths and environment-backed settings
│   │   ├── domain/         # Sessions, frames, OCR/translation models
│   │   ├── ocr/            # ONNX detector, recognizers, perspective crops
│   │   ├── pipeline/       # Layout, dedupe, cache, Japanese readings
│   │   ├── services/       # Session registry
│   │   └── translation/    # Local/remote providers and language mapping
│   ├── resources/ocr/      # Recognition dictionaries
│   ├── tests/
│   └── .env.example
├── shared/protocol/v1/     # Canonical schema and fixtures
├── data/profiles/          # Ignored device-local profile state
├── models/                # Ignored user-supplied model binaries
├── docs/                  # Design reference
└── README.md              # Configuration and run guide
```

## Processing flow

```text
Chosen window / display region
    → filtered native macOS area capture / Electron source stream
    → Electron main samples at polling_ms, crops and encodes JPEG
    → /v1/stream binary frame.image
    → Python ONNX OCR → reading order → dedupe/cache → translation
    → translation.result
    → Electron main → IPC → overlay and transcript
```

Main owns source selection, sampling, sessions, and backend communication. The
capture renderer exists because video and canvas decoding require browser APIs.
It has no backend connection. Visible renderers receive typed results through
preload IPC rather than owning WebSockets.

## Desktop capture modes

| Mode | Source and purpose |
|---|---|
| `selected_window` | One app window; books, manga, articles, or an entire game window |
| `one_large_area` | One rectangle on a selected display |
| `multiple_regions` | Several independently submitted rectangles |

Selected Window captures the window image rather than the surrounding desktop.
System menu bars, the Dock, and unrelated windows are excluded; the selected
app's own title bar or toolbars may remain. The stream follows window movement
and resizing. Window availability during minimization or native full-screen
transitions depends on the operating system.

The macOS window chooser uses transparent selection surfaces on every display.
A small Core Graphics helper reports visible application windows in front-to-back
order, excluding this process. Main hit-tests the pointer against their global
bounds and highlights the frontmost window underneath it. Click selects; Escape
or right-click cancels. There is no window list. Main revalidates the selected
window against Electron's capture sources without requesting thumbnails.
The helper streams metadata during selection and stops on selection, cancellation or quit.
Selected-window capture also invokes it in one-shot mode to read current window bounds.
It reads window metadata, never images, and does not require Accessibility access.
The build compiles it into `dist/native/window-picker` using Xcode Command Line Tools.
Hover selection currently supports macOS; other platforms need their own native implementation.
Changing capture mode immediately opens its selection phase. Every mode commits
only after selection is confirmed; cancellation retains the previous mode and settings.
Runtime window IDs are not persisted because they may be reused.
A restart or profile switch therefore requires a fresh selection. Legacy
`full_screen` profiles migrate to `selected_window`; the old display-only
setting is removed. Full Screen is no longer a selectable mode.

Area modes still capture an underlying display stream, then crop the requested
rectangle(s) in main. Removing the Full Screen UI mode does not remove display
capture needed for these areas. Multiple Regions edits a draft of numbered
rectangles on the chosen display. Draw repeatedly to add rectangles, remove one
with ×, undo the last rectangle, or clear that display's draft. Enter or Apply
regions commits the entire edited set; Escape or right-click discards the draft.
Saved regions on other displays are preserved, and reopening the picker loads
the existing rectangles. One Large Area still confirms on mouse release.
Results use one combined card per captured region in Multiple Regions and one
card per OCR block in Selected Window. Region IDs remain index-based; custom labels,
stable IDs, and dragging/resizing existing rectangles remain future work.

## Capture lifecycle and recovery

Selected Window uses a persistent Electron stream. Windows/Linux area capture
also uses persistent display streams. Source enumeration requests IDs with
zero-sized thumbnails; OCR frames come from video rather than preview thumbnails.

On macOS 14+, area capture uses ScreenCaptureKit's `SCScreenshotManager` with
an `SCContentFilter` that excludes the current overlay window IDs. A native helper
returns a transient full-resolution PNG over stdout at each polling interval;
all regions on the same display share that capture before cropping. Overlay
windows remain visible to the user, and underlying source content is preserved.
There is no fallback to unfiltered display capture. The helper is compiled into
`dist/native/display-capture` and is terminated if capture stops or times out.

Windows overlay windows enable Electron's `setContentProtection(true)` before
being shown. On Windows 10 version 2004+ and Windows 11, this uses
`WDA_EXCLUDEFROMCAPTURE`; older Windows versions may produce a black area instead.
This path requires physical Windows verification. macOS cannot rely on that
Electron flag, so exclusion is applied in the ScreenCaptureKit filter instead.
See [Electron capture protection](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable-macos-windows)
and [Apple filtered screenshots](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager).

The hidden capture worker uses a sandboxed BrowserWindow with Node integration
disabled. Main's display-media handler grants only the selected source to that
worker, with audio disabled. Main samples decoded frames at `polling_ms`.
Crop transforms account for display scale and origin, including negative monitor
coordinates. JPEG encoding limits the long edge to 3200 pixels and enforces the
4 MiB protocol limit.

Visually identical encoded frames are skipped after the first two samples, with
a periodic unchanged sample retained. Two samples are needed for the backend's
stable-empty OCR clearing behavior.

A live stream can be temporarily muted or have no decoded frame. These samples
are skipped while keeping the stream open; they are not sent as empty OCR.
A continuous unavailable period of 15 seconds raises an error. Ended tracks and
other permanent capture failures are reported with the source and failing stage.
Worker exceptions are serialized inside the renderer so Electron's generic
script-execution error does not hide the real cause.

Streams are released on pause, backend disconnection, source changes, and quit.
Changing sources or sessions suppresses stale pending capture work. Network
reconnect delays are 1, 2, 4, 8, then 15 seconds. The previous successful
translation remains visible during processing or failures.

## Renderer and tray responsibilities

| Renderer folder | Responsibility | Window role |
|---|---|---|
| `capture/` | Decode the source stream and return in-memory image frames | Hidden worker |
| `control/` | Profiles, capture actions, pause, transcript/settings access | Tray-opened controls |
| `overlay/` | Bilingual result display, placement, style settings | Transparent always-on-top window |
| `picker/` | Draw rectangles and select a display for area capture | Temporary display-covering windows |
| `transcript/` | Show OCR/translation results and timing | On-demand history window |
| `window-picker/` | Highlight the window under the pointer; click or cancel | Temporary transparent picker |

## Desktop overlay layout

One Large Area keeps the combined bilingual box with its existing placement and
drag settings. Selected Window displays one bilingual card per OCR block, using
that block's source and `translatedText`. Multiple Regions displays one card per
captured image/region, using `combinedSourceText` and `combinedTranslatedText`.
These cards use source above translation, left alignment and horizontal, top-to-bottom wrapping.
In Selected Window, card width follows content up to the configured maximum.
In Multiple Regions, each card matches its selected area's width, constrained to
the display work area, and has no width setting. Card height adjusts to the text.

Cards start at the block's left edge and bottom (`x`, `y + height`), or the full
capture rectangle's left edge and bottom for Multiple Regions. If a card
does not fit below, it moves above. Both axes are then clamped to the display's
work area, excluding the menu bar and Dock. Oversized cards are constrained to
the work area. Each display has an overlay surface in block modes.

Desktop-only IPC attaches the captured source's global logical rectangle to each
result. Normalized OCR rectangles project through that rectangle, accounting for
JPEG resizing, Retina scale, crop offsets and negative monitor origins. The
selected window's current rectangle is refreshed at the capture polling interval,
including visually unchanged samples, so cards follow movement without requiring
another translation. The WebSocket schema is unchanged.

Each region has independent block cards and an auto-hide timer. New frames
replace that region's cards, and `translation.clear` removes only the matching
region. Older results and clears are ignored. Existing cards remain while a new
frame translates or the backend is unavailable. Server text-direction metadata
can be added later without changing this block-to-translation mapping.

These are separate responsibilities, not duplicate capture implementations.
Consolidating transcript and window selection into the control window would be a
future UI refactor; the current implementation still has six renderer folders.

The application runs from a tray icon, or macOS menu-bar icon. Controls start
hidden. Clicking the icon opens controls; closing controls hides them without
stopping capture. The tray context menu provides Show Controls and Quit. macOS
uses accessory activation without a Dock icon.

## Configuration and profiles

Each deployable app has its own local environment file and committed example.
Backend configuration owns server binding/authentication and translation provider
settings. Desktop configuration owns the backend endpoint/token and optional
default profile. Root `.env` and `config/runtime.json` are no longer used.

Profiles contain mutable capture regions, polling interval, source/target
languages, and overlay placement/style. Connection credentials are injected at
runtime and excluded when saving profile settings.

`ProfileStore` owns create, list, load, rename, validation, and file writes under
`data/profiles/`. It rejects invalid paths and duplicate names. The selected
profile ID is persisted in `.active-profile`; a launch override takes precedence.
Legacy `game_id` becomes `profile_id` when profiles are loaded/saved.

## Protocol V1

The source of truth is
[messages.schema.json](../shared/protocol/v1/messages.schema.json), with examples in
[fixtures](../shared/protocol/v1/fixtures). Python and desktop types implement this
contract; mobile clients can implement the same protocol.

One endpoint, `/v1/stream`, carries the handshake, session control, frames,
results, clears, errors, and ping/pong. Desktop advertises `server-onnx` and sends
images. The contract also accepts device OCR through `frame.text`.

Image frames use the binary envelope:

```text
ALO1 | UInt32 big-endian JSON header length | UTF-8 JSON header | JPEG bytes
```

The header identifies the session, region, frame, timestamp, upright image
dimensions, MIME type, and client OCR diagnostics. Header size is limited to
64 KiB; images to 4 MiB; text frames to 100 blocks and 16,000 source characters.
Frame IDs are monotonically increasing UInt64 values encoded as decimal strings.
OCR rectangles use normalized top-left-origin coordinates relative to the
submitted image.

The gateway owns validation, authentication, and independent session state.
Region workers complete in-flight work while retaining only the newest queued
frame for that region. Pause/settings revisions prevent old work from publishing.
Results and confirmed-empty clears are independent by `regionId`; the desktop
ignores responses older than the latest accepted result for that region.

## OCR and translation

The ONNX detector finds quadrilaterals, which are perspective-cropped before
recognition. Tall crops are rotated into recognizer orientation. Recognizers
provide text and confidence. Layout analysis orders horizontal text top-to-bottom
and left-to-right, or predominantly vertical CJK text right-to-left.

English and Korean have dedicated recognizers; Japanese and Chinese use the
general CJK model. Source language identifiers are
`auto/en/ja/ko/zh-Hans/zh-Hant`; targets are `en/zh-Hant/ja`. Provider-specific
language names belong in `translation/language_mapping.py`.

Backend code iterates through the ordered OCR blocks and makes one translation
request per block. Each request contains only that block's source text and the
languages. The model returns plain translation text; backend code attaches it to
the original block ID. The model does not split blocks or return IDs or JSON.
There is no model-output JSON parser or grammar. The shared llama.cpp context
serializes generation across sessions, and remote requests are sequential per frame.
This trades cross-block context and additional calls for direct block-to-translation mapping.

A bounded in-memory cache is keyed by block IDs, normalized source and block
boundaries, languages, and provider revision. Invalid responses never enter the
cache or update dedupe state. Region dedupe suppresses repeated results. Two stable empty OCR
samples trigger `translation.clear`.

Each result block carries its own `translatedText` alongside the original OCR
rectangle, confidence, reading order and optional Japanese readings.
`combinedTranslatedText` joins those translations in source reading order for
the existing overlay and transcript. Empty or invalid block translations emit the retryable
`translation_alignment_failed` error without a result or clear; the client keeps
its previous successful result. Desktop block overlays use these aligned translations.
The frame succeeds only after every block translates successfully. Local output
reported as truncated is rejected too; `OVERLAY_LLM_MAX_TOKENS` applies to each block.

## OCR position coordinates

Temporary desktop logs tagged `[desktop-ocr-positions]` expose source blocks from
successful Selected Window results:

- `normalizedBounds`: values in [0,1], relative to the uploaded window image.
- `imageBoundsPx`: coordinates in the uploaded JPEG after resizing.
- `windowId` and `windowName`: the source associated with that submitted frame.
- `screenBoundsDip`: the OCR block projected into global desktop logical coordinates
  using captured source geometry. macOS window bounds come from the native helper.
- `displayLocalBoundsDip`: display-local logical coordinates for display/region
  capture; null for window sources.

Internal display-capture diagnostics can also project normalized rectangles into
display-local logical coordinates and global screen coordinates, including
negative monitor offsets. Those projections use the geometry retained for the
specific frame. Window-local image coordinates cannot be used directly as global
overlay coordinates.

## External translation API

The remote provider sends one HTTP POST per OCR block, authenticated when an API
token is set, using this request body:

```json
{
  "text": "おはよう。",
  "source_lang": "ja",
  "target_lang": "en"
}
```

The response contains a plain translated string in `translated_text`,
`translatedText`, or `text`:

```json
{
  "translated_text": "Good morning."
}
```

JSON is only the HTTP envelope; model input and output remain plain text. IDs
stay inside the backend and are never delegated to the external service.
The shared WebSocket schema is unchanged: it already includes `translatedText`
on every block. The duplicate standalone
`translation_server.py` implementation has been removed; the backend loads
llama.cpp directly or connects to an external provider.

## Data lifetime and current limits

Captured images stay transient and are not stored in profile/history files.
The transcript currently keeps up to 500 results in desktop process memory;
it is not a persistent history database. Profiles remain device-local, and
cross-device history sync is out of scope.

Temporary OCR diagnostic logs include recognized text and source metadata, so
the application does not currently promise text-free logs. Backend processing
exceptions are logged server-side; clients receive safe protocol errors.

Pending work includes richer region management, further overlay styling,
and server text direction metadata.

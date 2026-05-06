"""ax_source.py — Read text from macOS Live Captions via the Accessibility API.

macOS protects the Live Captions window from screen capture (kCGWindowSharingNone),
so mss / CoreGraphics cannot grab it.  The window IS fully exposed through the
Accessibility API, which is what this module uses via osascript / AppleScript.

Requirements: no extra Python packages — osascript ships with macOS.
Accessibility permission for the Terminal / Python executable is required (same
permission already needed for PaddleOCR's region capture on protected apps).
"""
from __future__ import annotations

import asyncio
import subprocess
import time
from typing import AsyncIterator

from .textproc import confidence_for_text, dedupe_key

# ---------------------------------------------------------------------------
# AppleScript: traverse the Live Captions window's full accessibility tree and
# collect every AXStaticText value.  "entire contents" does a depth-first walk
# so we don't need to know the exact hierarchy (it varies across macOS versions).
# ---------------------------------------------------------------------------
_LIVE_CAPTIONS_SCRIPT = """\
tell application "System Events"
    if not (exists process "Live Captions") then return ""
    tell process "Live Captions"
        if (count of windows) = 0 then return ""
        set allItems to entire contents of window 1
        set captionLines to {}
        repeat with anItem in allItems
            try
                if role of anItem is "AXStaticText" then
                    set v to value of anItem
                    if v is not missing value and v is not "" then
                        set end of captionLines to v
                    end if
                end if
            end try
        end repeat
        set AppleScript's text item delimiters to "\n"
        set joined to captionLines as text
        set AppleScript's text item delimiters to ""
        return joined
    end tell
end tell
"""


def _read_live_captions_sync() -> str:
    """Blocking call — run inside an executor so it doesn't block the event loop."""
    try:
        result = subprocess.run(
            ["osascript", "-e", _LIVE_CAPTIONS_SCRIPT],
            capture_output=True,
            text=True,
            timeout=3.0,
        )
        if result.returncode != 0:
            # osascript stderr often contains helpful diagnostics; swallow silently
            return ""
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        return ""
    except Exception:
        return ""


async def ax_stream(game: str, interval_ms: int) -> AsyncIterator[dict]:
    """Yield subtitle events by polling macOS Live Captions via Accessibility API."""
    interval_s = max(interval_ms, 200) / 1000
    loop = asyncio.get_event_loop()
    last_warn_at = 0.0
    warn_cooldown_s = 5.0

    while True:
        text = await loop.run_in_executor(None, _read_live_captions_sync)
        now = time.time()

        if text == "" and now - last_warn_at >= warn_cooldown_s:
            last_warn_at = now

        yield {
            "type": "subtitle",
            "profile": game,
            "timestamp": now,
            "source_text": text,
            "translated_text": "",
            "lang_src": "auto",
            "lang_dst": "en",
            "confidence": confidence_for_text(text),
            "dedupe_key": dedupe_key(text),
            "hide_after_ms": 5000,
        }
        await asyncio.sleep(interval_s)

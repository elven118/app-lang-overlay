from __future__ import annotations

import argparse
import asyncio

from .server import run_overlay_backend


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="app_lang_overlay.cli")
    sub = parser.add_subparsers(dest="command", required=True)

    backend = sub.add_parser("overlay-backend")
    backend.add_argument("--game", default="demo")
    backend.add_argument("--host", default="127.0.0.1")
    backend.add_argument("--port", type=int, default=8765)
    backend.add_argument("--interval-ms", type=int, default=900)
    backend.add_argument("--input-mode", default="ocr")
    backend.add_argument("--ocr-lang", default="en")
    backend.add_argument("--auto-hide-ms", type=int, default=-1)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "overlay-backend":
        if args.input_mode not in ("fake", "ocr", "accessibility"):
            raise SystemExit("--input-mode must be one of: fake, ocr, accessibility")
        asyncio.run(
            run_overlay_backend(
                host=args.host,
                port=args.port,
                game=args.game,
                interval_ms=args.interval_ms,
                input_mode=args.input_mode,
                ocr_lang=args.ocr_lang,
                auto_hide_ms=args.auto_hide_ms,
            )
        )


if __name__ == "__main__":
    main()

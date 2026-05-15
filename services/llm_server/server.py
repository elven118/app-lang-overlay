from __future__ import annotations

import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


def _build_prompt(source_text: str, target_lang: str) -> str:
    return (
        "You are a subtitle translator.\n"
        f"Translate to {target_lang}.\n"
        "Return only translated text in one line.\n"
        f"Input: {source_text}\n"
        "Output:"
    )


class TranslatorEngine:
    def __init__(
        self,
        model_path: str,
        max_tokens: int = 128,
        n_gpu_layers: int = -1,
        n_ctx: int = 2048,
        n_threads: int | None = None,
        n_batch: int = 512,
        chat_format: str | None = None,
    ) -> None:
        self.max_tokens = max_tokens
        self._llm = None

        model = Path(model_path)
        if not model.exists():
            raise FileNotFoundError(f"model not found: {model_path}")

        try:
            from llama_cpp import Llama
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("llama_cpp not installed") from exc

        threads = n_threads if n_threads is not None else max(os.cpu_count() or 4, 4)
        self._llm = Llama(
            model_path=str(model),
            n_gpu_layers=n_gpu_layers,
            n_ctx=n_ctx,
            n_threads=threads,
            n_batch=n_batch,
            chat_format=chat_format,
            verbose=False,
        )

    def translate(self, text: str, target_lang: str) -> str:
        if not text:
            return ""

        prompt = _build_prompt(text, target_lang)
        out = self._llm(prompt, max_tokens=self.max_tokens, temperature=0.1)
        translated = out["choices"][0]["text"].strip()
        return translated or text


class LlmRequestHandler(BaseHTTPRequestHandler):
    server_version = "OverlayLlmServer/1.0"

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any] | None:
        length_raw = self.headers.get("Content-Length", "0")
        try:
            length = int(length_raw)
        except ValueError:
            return None

        raw = self.rfile.read(max(0, length))
        if not raw:
            return {}

        try:
            parsed = json.loads(raw.decode("utf-8"))
        except Exception:
            return None
        return parsed if isinstance(parsed, dict) else None

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send_json(200, {"ok": True, "service": "llm_server"})
            return
        self._send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/translate":
            self._send_json(404, {"error": "not_found"})
            return

        api_key = getattr(self.server, "api_key", "")
        if api_key:
            auth = self.headers.get("Authorization", "")
            if auth != f"Bearer {api_key}":
                self._send_json(401, {"error": "unauthorized"})
                return

        payload = self._read_json()
        if payload is None:
            self._send_json(400, {"error": "invalid_json"})
            return

        source_text = str(payload.get("text") or "").strip()
        if not source_text:
            self._send_json(400, {"error": "text_required"})
            return

        target_lang = str(payload.get("target_lang") or "Chinese").strip() or "Chinese"

        engine = getattr(self.server, "engine", None)
        if engine is None:
            self._send_json(500, {"error": "engine_not_ready"})
            return

        try:
            translated = engine.translate(source_text, target_lang)
        except Exception as exc:
            self._send_json(500, {"error": "translate_failed", "detail": str(exc)})
            return

        self._send_json(
            200,
            {
                "translated_text": translated,
                "text": translated,
                "source_text": source_text,
                "target_lang": target_lang,
            },
        )

    def log_message(self, format: str, *args: object) -> None:
        print(f"[llm-server] {self.address_string()} - {format % args}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="services.llm_server.server")
    parser.add_argument("--host", default=os.getenv("LLM_SERVER_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.getenv("LLM_SERVER_PORT", "8790")))
    parser.add_argument(
        "--model-path",
        default=os.getenv("LLM_MODEL_PATH", "./models/HY-MT1.5-7B-Q4_K_M.gguf"),
    )
    parser.add_argument("--max-tokens", type=int, default=int(os.getenv("LLM_MAX_TOKENS", "256")))
    parser.add_argument("--n-gpu-layers", type=int, default=int(os.getenv("LLM_N_GPU_LAYERS", "-1")))
    parser.add_argument("--n-ctx", type=int, default=int(os.getenv("LLM_N_CTX", "2048")))
    parser.add_argument("--n-threads", type=int, default=int(os.getenv("LLM_N_THREADS", "0")))
    parser.add_argument("--n-batch", type=int, default=int(os.getenv("LLM_N_BATCH", "512")))
    parser.add_argument("--chat-format", default=os.getenv("LLM_CHAT_FORMAT", ""))
    parser.add_argument("--api-key", default=os.getenv("LLM_SERVER_API_KEY", ""))
    return parser


def run_server(args: argparse.Namespace) -> None:
    n_threads = args.n_threads if args.n_threads > 0 else None
    chat_format = args.chat_format.strip() or None

    engine = TranslatorEngine(
        model_path=args.model_path,
        max_tokens=args.max_tokens,
        n_gpu_layers=args.n_gpu_layers,
        n_ctx=args.n_ctx,
        n_threads=n_threads,
        n_batch=args.n_batch,
        chat_format=chat_format,
    )

    httpd = ThreadingHTTPServer((args.host, args.port), LlmRequestHandler)
    httpd.engine = engine
    httpd.api_key = args.api_key.strip()

    print(
        f"[llm-server] listening on http://{args.host}:{args.port} "
        f"model={args.model_path} auth={'on' if httpd.api_key else 'off'}"
    )
    print("[llm-server] endpoints: GET /health, POST /translate")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    run_server(args)


if __name__ == "__main__":
    main()

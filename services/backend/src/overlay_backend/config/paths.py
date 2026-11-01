from __future__ import annotations

import os
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = PACKAGE_ROOT.parents[1]

_configured_project_root = os.getenv("OVERLAY_PROJECT_ROOT", "").strip()
PROJECT_ROOT = (
    Path(_configured_project_root).expanduser().resolve()
    if _configured_project_root
    else BACKEND_ROOT.parents[1]
)

_configured_models_root = os.getenv("OVERLAY_MODELS_ROOT", "").strip()
MODELS_ROOT = (
    Path(_configured_models_root).expanduser().resolve()
    if _configured_models_root
    else PROJECT_ROOT / "models"
)

OCR_RESOURCES_ROOT = BACKEND_ROOT / "resources" / "ocr"

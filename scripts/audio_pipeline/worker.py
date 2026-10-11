"""Shared execution contract for Cove audio queue producers and subscribers."""
from __future__ import annotations

import os
import pathlib
import shutil
import tempfile
import time
from types import SimpleNamespace
from typing import Literal

from pydantic import BaseModel, Field

from .runner import run

AUDIO_TRIGGER_TOPIC = "cove-audio-pipeline-v2"
AUDIO_TRIGGER_GROUP = "cove-audio-pipeline-worker-v2"

RUN_ROOT = pathlib.Path("/tmp/cove-audio-runs")
RDF_CACHE = pathlib.Path("/tmp/cove-rdf-cache")
MODEL_CACHE = pathlib.Path("/tmp/cove-model-cache")
RUNTIME_HOME = pathlib.Path("/tmp/cove-runtime-home")
XDG_CACHE = pathlib.Path("/tmp/cove-xdg-cache")
HF_HOME = pathlib.Path("/tmp/cove-huggingface")
NUMBA_CACHE = pathlib.Path("/tmp/cove-numba-cache")
STALE_RUN_SECONDS = 20 * 60


class RunRequest(BaseModel):
    kind: Literal["discover", "track", "align"] | None = None
    max_jobs: int = Field(default=1, ge=0, le=24)
    minutes: int = Field(default=4, ge=1, le=5)
    no_discovery: bool = True
    threads: int = Field(default=2, ge=1, le=4)


def api_url() -> str:
    value = (
        os.environ.get("FORE_PIPELINE_API_URL")
        or os.environ.get("FORE_BACKEND_URL")
        or os.environ.get("FORE_SITE_URL")
    )
    if not value:
        raise RuntimeError("FORE_BACKEND_URL (or FORE_PIPELINE_API_URL) is required")
    return value.rstrip("/")


def gateway_token() -> str:
    value = os.environ.get("FORE_BACKEND_TOKEN", "")
    if len(value) < 24:
        raise RuntimeError("FORE_BACKEND_TOKEN is not configured for the audio service")
    return value


def service_token() -> str:
    value = os.environ.get("FORE_SERVICE_TOKEN")
    if not value:
        raise RuntimeError("FORE_SERVICE_TOKEN is not configured for the audio service")
    return value


def pipeline_config() -> dict[str, str]:
    return {
        "siteUrl": api_url(),
        "pipelineToken": service_token(),
        "gatewayToken": gateway_token(),
        "siteBearer": os.environ.get("FORE_SITE_BEARER", ""),
    }


def _prepare_runtime_cache() -> pathlib.Path:
    RUN_ROOT.mkdir(parents=True, exist_ok=True)
    RDF_CACHE.mkdir(parents=True, exist_ok=True)
    MODEL_CACHE.mkdir(parents=True, exist_ok=True)
    RUNTIME_HOME.mkdir(parents=True, exist_ok=True)
    XDG_CACHE.mkdir(parents=True, exist_ok=True)
    HF_HOME.mkdir(parents=True, exist_ok=True)
    NUMBA_CACHE.mkdir(parents=True, exist_ok=True)

    cutoff = time.time() - STALE_RUN_SECONDS
    for path in RUN_ROOT.glob("run-*"):
        try:
            if path.is_dir() and path.stat().st_mtime < cutoff:
                shutil.rmtree(path, ignore_errors=True)
        except FileNotFoundError:
            continue

    # Vercel's deployed source tree is read-only. ML/runtime dependencies may
    # consult HOME/XDG/Hugging Face defaults even when faster-whisper receives
    # an explicit download_root, so force every writable cache under /tmp.
    os.environ["HOME"] = str(RUNTIME_HOME)
    os.environ["XDG_CACHE_HOME"] = str(XDG_CACHE)
    os.environ["HF_HOME"] = str(HF_HOME)
    os.environ["HF_HUB_CACHE"] = str(HF_HOME / "hub")
    os.environ["HUGGINGFACE_HUB_CACHE"] = str(HF_HOME / "hub")
    os.environ["TRANSFORMERS_CACHE"] = str(HF_HOME / "transformers")
    os.environ["TORCH_HOME"] = str(XDG_CACHE / "torch")
    os.environ["NUMBA_CACHE_DIR"] = str(NUMBA_CACHE)
    os.environ["FORE_RDF_CACHE"] = str(RDF_CACHE)
    os.environ["FORE_MODEL_CACHE"] = str(MODEL_CACHE)
    os.environ.setdefault("TMPDIR", "/tmp")
    return pathlib.Path(tempfile.mkdtemp(prefix="run-", dir=RUN_ROOT))


def pipeline_args(request: RunRequest, cache: pathlib.Path) -> SimpleNamespace:
    return SimpleNamespace(
        cache=str(cache),
        minutes=request.minutes,
        max_jobs=request.max_jobs,
        kind=request.kind,
        no_discovery=request.no_discovery,
        threads=request.threads,
    )


def execute_pipeline(request: RunRequest) -> None:
    cache = _prepare_runtime_cache()
    try:
        run(pipeline_config(), pipeline_args(request, cache))
    finally:
        # Audio/EPUB/transcript intermediates are per delivery. Model and RDF
        # caches live outside RUN_ROOT so warm consumers can reuse them safely.
        shutil.rmtree(cache, ignore_errors=True)

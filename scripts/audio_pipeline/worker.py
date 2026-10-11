"""Shared execution contract for Cove audio queue producers and subscribers."""
from __future__ import annotations

import logging
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
STALE_RUN_SECONDS = 6 * 60  # Function executions are capped at five minutes.
logger = logging.getLogger("cove.audio_pipeline.worker")


def _disk_snapshot() -> dict[str, int]:
    usage = shutil.disk_usage("/tmp")
    return {
        "total_mb": usage.total // (1024 * 1024),
        "used_mb": usage.used // (1024 * 1024),
        "free_mb": usage.free // (1024 * 1024),
    }


class RunRequest(BaseModel):
    kind: Literal["discover", "track", "align"] | None = None
    execution_mode: Literal["inherit", "direct", "queue"] = "inherit"
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
    # These caches are disposable and have previously retained failed Xet/model
    # reconstruction data across warm invocations. Clear them before acquiring
    # new media so a completed track cannot starve BioSync of model space.
    for path in (RUNTIME_HOME, HF_HOME):
        shutil.rmtree(path, ignore_errors=True)
    RUN_ROOT.mkdir(parents=True, exist_ok=True)
    RDF_CACHE.mkdir(parents=True, exist_ok=True)
    MODEL_CACHE.mkdir(parents=True, exist_ok=True)
    RUNTIME_HOME.mkdir(parents=True, exist_ok=True)
    XDG_CACHE.mkdir(parents=True, exist_ok=True)
    HF_HOME.mkdir(parents=True, exist_ok=True)
    NUMBA_CACHE.mkdir(parents=True, exist_ok=True)

    cutoff = time.time() - STALE_RUN_SECONDS
    # An interrupted five-minute invocation can otherwise pin hundreds of MB
    # for twenty minutes and prevent the next BioSync model preflight.
    # Never delete a run less than six minutes old: another invocation may
    # still be processing its leased audio.
    for path in RUN_ROOT.glob("run-*"):
        try:
            if path.is_dir() and path.stat().st_mtime < cutoff:
                shutil.rmtree(path, ignore_errors=True)
        except FileNotFoundError:
            continue

    # The previous worker kept every Gutenberg RDF response in a shared cache
    # for 20 hours. Thousands of discovery requests could exhaust the same
    # small /tmp filesystem needed by BioSync's speech model. New requests use
    # their own run-scoped RDF cache, so only reclaim legacy responses that
    # cannot belong to an invocation still inside the five-minute limit.
    for path in RDF_CACHE.glob("*.rdf"):
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        except OSError:
            logger.warning("Unable to clear a stale Gutenberg RDF cache entry")

    cache = pathlib.Path(tempfile.mkdtemp(prefix="run-", dir=RUN_ROOT))

    # Vercel's deployed source tree is read-only. ML/runtime dependencies may
    # consult HOME/XDG/Hugging Face defaults even when faster-whisper receives
    # an explicit download_root, so force every writable cache under /tmp.
    os.environ["HOME"] = str(RUNTIME_HOME)
    os.environ["XDG_CACHE_HOME"] = str(XDG_CACHE)
    os.environ["HF_HOME"] = str(HF_HOME)
    # hf-xet reconstructs model files in scratch space and can exhaust Vercel's
    # 512 MB /tmp filesystem. Use normal Hub downloads for faster-whisper models.
    os.environ["HF_HUB_DISABLE_XET"] = "1"
    os.environ["HF_HUB_CACHE"] = str(HF_HOME / "hub")
    os.environ["HUGGINGFACE_HUB_CACHE"] = str(HF_HOME / "hub")
    os.environ["TRANSFORMERS_CACHE"] = str(HF_HOME / "transformers")
    # Xet's reconstruction workspace is optimized for durable local disks and
    # can consume substantial ephemeral storage. Serverless workers benefit
    # from the regular Hub download path instead.
    os.environ["HF_HUB_DISABLE_XET"] = "1"
    os.environ["HF_XET_CHUNK_CACHE_SIZE_BYTES"] = "0"
    os.environ["HF_XET_RECONSTRUCT_WRITE_SEQUENTIALLY"] = "1"
    os.environ["TORCH_HOME"] = str(XDG_CACHE / "torch")
    os.environ["NUMBA_CACHE_DIR"] = str(NUMBA_CACHE)
    os.environ["FORE_RDF_CACHE"] = str(cache / "rdf")
    os.environ["FORE_MODEL_CACHE"] = str(MODEL_CACHE)
    os.environ["TMPDIR"] = str(RUN_ROOT)
    os.environ["TMP"] = str(RUN_ROOT)
    os.environ["TEMP"] = str(RUN_ROOT)
    # tempfile caches its chosen directory process-wide. Reset it after forcing
    # every temp-related environment variable into Vercel's writable /tmp tree.
    tempfile.tempdir = str(RUN_ROOT)
    return cache


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
    logger.info(
        "Cove audio pipeline disk before kind=%s stats=%s",
        request.kind,
        _disk_snapshot(),
    )
    try:
        run(pipeline_config(), pipeline_args(request, cache))
    except Exception:
        logger.exception(
            "Cove audio pipeline failed kind=%s disk=%s",
            request.kind,
            _disk_snapshot(),
        )
        raise
    finally:
        # Audio/EPUB/transcript intermediates are per delivery. Model and RDF
        # caches live outside RUN_ROOT so warm consumers can reuse them safely.
        shutil.rmtree(cache, ignore_errors=True)
        logger.info(
            "Cove audio pipeline disk after kind=%s stats=%s",
            request.kind,
            _disk_snapshot(),
        )

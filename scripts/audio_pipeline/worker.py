"""Shared execution contract for Cove audio queue producers and subscribers."""
from __future__ import annotations

import os
from types import SimpleNamespace
from typing import Literal

from pydantic import BaseModel, Field

from .runner import run

AUDIO_TRIGGER_TOPIC = "cove-audio-pipeline-v2"
AUDIO_TRIGGER_GROUP = "cove-audio-pipeline-worker-v2"


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


def pipeline_args(request: RunRequest) -> SimpleNamespace:
    return SimpleNamespace(
        cache="/tmp/cove-audio-pipeline",
        minutes=request.minutes,
        max_jobs=request.max_jobs,
        kind=request.kind,
        no_discovery=request.no_discovery,
        threads=request.threads,
    )


def execute_pipeline(request: RunRequest) -> None:
    run(pipeline_config(), pipeline_args(request))

"""Vercel Services HTTP wrapper for Cove's bounded audio worker.

The service is internal by default. The worker itself calls the Cove app through
the COVE_APP_INTERNAL_URL service binding. Long-running orchestration/scheduling
is intentionally left outside this wrapper until deployment limits are confirmed.
"""
from __future__ import annotations

import os
from types import SimpleNamespace
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .runner import run

app = FastAPI(title="Cove audio pipeline", docs_url=None, redoc_url=None)


class RunRequest(BaseModel):
    kind: Literal["discover", "track"] | None = None
    max_jobs: int = Field(default=1, ge=1, le=3)
    minutes: int = Field(default=4, ge=1, le=10)
    no_discovery: bool = True
    threads: int = Field(default=2, ge=1, le=4)


def _app_url() -> str:
    value = os.environ.get("COVE_APP_INTERNAL_URL") or os.environ.get("FORE_SITE_URL")
    if not value:
        raise HTTPException(
            status_code=503,
            detail="COVE_APP_INTERNAL_URL service binding is unavailable",
        )
    return value.rstrip("/")


def _service_token() -> str:
    value = os.environ.get("FORE_SERVICE_TOKEN")
    if not value:
        raise HTTPException(
            status_code=503,
            detail="FORE_SERVICE_TOKEN is not configured for the audio service",
        )
    return value


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "appBinding": bool(
            os.environ.get("COVE_APP_INTERNAL_URL") or os.environ.get("FORE_SITE_URL")
        ),
    }


@app.post("/run")
def run_pipeline(request: RunRequest) -> dict[str, object]:
    config = {
        "siteUrl": _app_url(),
        "pipelineToken": _service_token(),
        "siteBearer": os.environ.get("FORE_SITE_BEARER", ""),
    }
    args = SimpleNamespace(
        cache="/tmp/cove-audio-pipeline",
        minutes=request.minutes,
        max_jobs=request.max_jobs,
        kind=request.kind,
        no_discovery=request.no_discovery,
        threads=request.threads,
    )
    run(config, args)
    return {
        "ok": True,
        "requestedMaxJobs": request.max_jobs,
        "requestedMinutes": request.minutes,
    }

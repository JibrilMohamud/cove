"""Vercel container wrapper and durable queue worker for Cove audio preparation.

Cloudflare owns the durable schedule. Signed scheduler requests enqueue small
messages and return immediately; this container polls Vercel Queues and performs
the heavyweight Gutenberg/audio/BioSync work without holding the scheduler HTTP
connection open.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from contextlib import asynccontextmanager, suppress
from datetime import timedelta
from types import SimpleNamespace
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from vercel.queue import ALL_DEPLOYMENTS, QueueClient, subscribe

from .runner import run

logger = logging.getLogger("cove.audio_pipeline")
AUDIO_TRIGGER_TOPIC = "cove-audio-pipeline-v1"
AUDIO_TRIGGER_GROUP = "cove-audio-pipeline-worker-v1"


class RunRequest(BaseModel):
    kind: Literal["discover", "track", "align"] | None = None
    max_jobs: int = Field(default=1, ge=0, le=24)
    minutes: int = Field(default=4, ge=1, le=10)
    no_discovery: bool = True
    threads: int = Field(default=2, ge=1, le=4)


def _api_url() -> str:
    value = (
        os.environ.get("FORE_PIPELINE_API_URL")
        or os.environ.get("FORE_BACKEND_URL")
        or os.environ.get("FORE_SITE_URL")
    )
    if not value:
        raise RuntimeError("FORE_BACKEND_URL (or FORE_PIPELINE_API_URL) is required")
    return value.rstrip("/")


def _gateway_token() -> str:
    value = os.environ.get("FORE_BACKEND_TOKEN", "")
    if len(value) < 24:
        raise RuntimeError("FORE_BACKEND_TOKEN is not configured for the audio service")
    return value


def _service_token() -> str:
    value = os.environ.get("FORE_SERVICE_TOKEN")
    if not value:
        raise RuntimeError("FORE_SERVICE_TOKEN is not configured for the audio service")
    return value


def _pipeline_config() -> dict[str, str]:
    return {
        "siteUrl": _api_url(),
        "pipelineToken": _service_token(),
        "gatewayToken": _gateway_token(),
        "siteBearer": os.environ.get("FORE_SITE_BEARER", ""),
    }


def _pipeline_args(request: RunRequest) -> SimpleNamespace:
    return SimpleNamespace(
        cache="/tmp/cove-audio-pipeline",
        minutes=request.minutes,
        max_jobs=request.max_jobs,
        kind=request.kind,
        no_discovery=request.no_discovery,
        threads=request.threads,
    )


def _execute_pipeline(request: RunRequest) -> None:
    run(_pipeline_config(), _pipeline_args(request))


@subscribe(
    topic=AUDIO_TRIGGER_TOPIC,
    consumer_group=AUDIO_TRIGGER_GROUP,
    retry_after=30,
)
async def consume_audio_trigger(payload: dict[str, object]) -> None:
    request = RunRequest.model_validate(payload)
    logger.info(
        "Starting queued Cove audio run kind=%s max_jobs=%s",
        request.kind,
        request.max_jobs,
    )
    await asyncio.to_thread(_execute_pipeline, request)
    logger.info(
        "Completed queued Cove audio run kind=%s max_jobs=%s",
        request.kind,
        request.max_jobs,
    )


async def _poll_audio_queue(queue: QueueClient) -> None:
    while True:
        try:
            await queue.poll_and_handle(
                consume_audio_trigger,
                interval=1.0,
                limit=1,
                lease_duration=600,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Cove audio queue poller failed; retrying")
            await asyncio.sleep(5)


@asynccontextmanager
async def lifespan(app: FastAPI):
    queue = QueueClient(deployment=ALL_DEPLOYMENTS)
    app.state.audio_queue = queue
    poller = asyncio.create_task(_poll_audio_queue(queue), name="cove-audio-queue-poller")
    app.state.audio_queue_poller = poller
    try:
        yield
    finally:
        poller.cancel()
        with suppress(asyncio.CancelledError):
            await poller


app = FastAPI(
    title="Cove audio pipeline",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)


@app.get("/health")
def health() -> dict[str, object]:
    poller = getattr(app.state, "audio_queue_poller", None)
    return {
        "ok": True,
        "persistenceBackend": bool(
            os.environ.get("FORE_PIPELINE_API_URL")
            or os.environ.get("FORE_BACKEND_URL")
            or os.environ.get("FORE_SITE_URL")
        ),
        "queueWorker": bool(poller and not poller.done()),
    }


@app.post("/run")
async def enqueue_pipeline(request: RunRequest) -> dict[str, object]:
    # Validate execution credentials before accepting durable work so a broken
    # deployment fails at the scheduler boundary rather than accumulating
    # messages that can never reach Cove's persistent backend.
    try:
        _pipeline_config()
    except Exception as error:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "audio_pipeline_configuration_unavailable",
                "message": str(error)[:500],
                "retryable": True,
            },
        ) from error

    payload = request.model_dump()
    bucket = int(time.time() // 300)
    payload_digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()[:20]
    idempotency_key = (
        f"cove-audio-{request.kind or 'scan'}-{bucket}-{payload_digest}"
    )

    queue: QueueClient = app.state.audio_queue
    try:
        message_id = await queue.send(
            AUDIO_TRIGGER_TOPIC,
            payload,
            idempotency_key=idempotency_key,
            retention=timedelta(hours=6),
        )
    except Exception as error:
        logger.exception("Unable to enqueue Cove audio pipeline work")
        raise HTTPException(
            status_code=503,
            detail={
                "error": "audio_queue_unavailable",
                "type": type(error).__name__,
                "message": str(error).replace("\n", " ").replace("\r", " ")[:700],
                "retryable": True,
            },
        ) from error

    return {
        "ok": True,
        "queued": True,
        "messageId": message_id,
        "kind": request.kind,
        "requestedMaxJobs": request.max_jobs,
        "requestedMinutes": request.minutes,
    }

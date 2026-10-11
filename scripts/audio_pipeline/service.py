"""Lightweight HTTP producer for Cove's durable Vercel audio queue.

Cloudflare owns the schedule. Signed scheduler requests validate Cove backend
credentials, enqueue one idempotent message, and return immediately. Vercel
push-mode subscriber functions perform heavyweight audio and BioSync work.
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
from datetime import timedelta

from fastapi import FastAPI, HTTPException
from vercel.queue import ALL_DEPLOYMENTS, QueueClient

from .worker import AUDIO_TRIGGER_TOPIC, RunRequest, pipeline_config

logger = logging.getLogger("cove.audio_pipeline")
queue = QueueClient(deployment=ALL_DEPLOYMENTS)

app = FastAPI(
    title="Cove audio pipeline",
    docs_url=None,
    redoc_url=None,
)


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "persistenceBackend": bool(pipeline_config()),
        "queueProducer": True,
        "queueMode": "push",
        "topic": AUDIO_TRIGGER_TOPIC,
    }


@app.post("/run")
async def enqueue_pipeline(request: RunRequest) -> dict[str, object]:
    # Fail at the scheduler boundary when execution credentials are missing.
    try:
        pipeline_config()
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
        f"cove-audio-v2-{request.kind or 'scan'}-{bucket}-{payload_digest}"
    )

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
        "queueMode": "push",
    }

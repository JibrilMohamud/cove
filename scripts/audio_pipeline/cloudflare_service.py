"""Private Cloudflare Container endpoint for Cove's existing Python audio engine.

Only the Cloudflare Queues consumer can reach this Container through its Durable
Object. Retains the canonical backend admission, rights and durable job leases.
"""
from __future__ import annotations

import asyncio
import hmac
import os

from fastapi import FastAPI, HTTPException, Request

from .worker import RunRequest, execute_pipeline, pipeline_config

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


def credentials_ready() -> bool:
    secret = os.environ.get("COVE_AUDIO_EXECUTION_SECRET", "")
    if len(secret) < 32:
        return False
    try:
        pipeline_config()
    except (ValueError, RuntimeError):
        return False
    return True


@app.get("/health")
def health() -> dict[str, object]:
    if not credentials_ready():
        raise HTTPException(status_code=503, detail="audio_credentials_unavailable")
    return {"ok": True, "provider": "cloudflare-container", "private": True}


@app.post("/run")
async def run(request: Request) -> dict[str, object]:
    secret = os.environ.get("COVE_AUDIO_EXECUTION_SECRET", "")
    received = request.headers.get("x-cove-execution-secret", "")
    if len(secret) < 32 or not hmac.compare_digest(secret, received):
        raise HTTPException(status_code=401, detail="unauthorized")
    if not credentials_ready():
        raise HTTPException(status_code=503, detail="audio_credentials_unavailable")
    try:
        body = await request.json()
        job = RunRequest.model_validate(body)
    except Exception as error:
        raise HTTPException(status_code=400, detail="invalid_audio_job") from error
    if job.execution_mode != "direct":
        raise HTTPException(status_code=400, detail="queue_delivery_must_execute_directly")
    try:
        executed = await asyncio.to_thread(execute_pipeline, job)
    except Exception as error:
        # Queue will retry and dead-letter failures. Never fabricate success.
        raise HTTPException(status_code=503, detail="audio_processing_failed") from error
    return {"ok": True, "executed": executed, "skipped": None if executed else "compute_budget"}

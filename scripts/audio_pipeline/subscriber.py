"""Push-mode Vercel Queue consumer for Cove audio ingestion."""
from __future__ import annotations

import asyncio
import logging
import urllib.request

from vercel.queue import Message, subscribe

from .worker import (
    AUDIO_TRIGGER_GROUP,
    AUDIO_TRIGGER_TOPIC,
    RunRequest,
    execute_pipeline,
)

logger = logging.getLogger("cove.audio_pipeline.subscriber")

_PROBE_URL = "https://cove-queue-probe.cove-jibrilmohamud.workers.dev/probe-lEUjepV2_yRLsl7OxqnyZ86aWEdcq_pz"


def _emit_delivery_probe(message_id: str) -> None:
    try:
        request = urllib.request.Request(
            _PROBE_URL,
            data=message_id.encode("utf-8"),
            headers={"content-type": "text/plain"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5):
            pass
    except Exception:
        # Diagnostic only: never fail or delay the real queue delivery.
        logger.debug("Cove queue delivery probe failed", exc_info=True)


@subscribe(
    topic=AUDIO_TRIGGER_TOPIC,
    consumer_group=AUDIO_TRIGGER_GROUP,
    retry_after=30,
    max_concurrency=2,
    max_attempts=8,
)
async def consume_audio_trigger(message: Message[dict[str, object]]) -> None:
    await asyncio.to_thread(_emit_delivery_probe, str(message.message_id))
    request = RunRequest.model_validate(message.payload)
    logger.info(
        "Starting Cove audio queue delivery id=%s kind=%s max_jobs=%s",
        message.message_id,
        request.kind,
        request.max_jobs,
    )
    await asyncio.to_thread(execute_pipeline, request)
    logger.info(
        "Completed Cove audio queue delivery id=%s kind=%s",
        message.message_id,
        request.kind,
    )

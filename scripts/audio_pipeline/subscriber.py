"""Push-mode Vercel Queue consumer for Cove audio ingestion."""
from __future__ import annotations

import asyncio
import logging
from vercel.queue import Message, subscribe

from .worker import (
    AUDIO_TRIGGER_GROUP,
    AUDIO_TRIGGER_TOPIC,
    RunRequest,
    execute_pipeline,
)

logger = logging.getLogger("cove.audio_pipeline.subscriber")

@subscribe(
    topic=AUDIO_TRIGGER_TOPIC,
    consumer_group=AUDIO_TRIGGER_GROUP,
    retry_after=30,
    max_concurrency=2,
    max_attempts=8,
)
async def consume_audio_trigger(message: Message[dict[str, object]]) -> None:
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

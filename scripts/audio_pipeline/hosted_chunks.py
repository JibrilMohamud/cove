"""Bounded, resumable hosted ASR for pinned long recordings.

R2 retains transcripts, not a Vercel /tmp directory. A checkpoint only waives
the current claim attempt when this lease actually saved a new ASR chunk.
"""
from __future__ import annotations

import hashlib
import math
import pathlib
import time
import wave

from .media import download, sha256


class TranscriptionPending(Exception):
    def __init__(self, index: int):
        self.index = index
        super().__init__(f"Independent ASR checkpoint saved through chunk {index}")


def pcm_chunk(source: pathlib.Path, target: pathlib.Path, offset: float, duration: float) -> pathlib.Path:
    """Seek using the source PTS, resample and trim to exact 16-kHz intervals."""
    import av

    rate = 16000
    first = round(offset * rate)
    samples = round(duration * rate)
    pcm = bytearray(samples * 2)
    copied = 0
    with av.open(str(source)) as container:
        stream = container.streams.audio[0]
        origin = float((stream.start_time or 0) * stream.time_base)
        container.seek(max(0, int((offset + origin - 1) / stream.time_base)), stream=stream, backward=True)
        resampler = av.AudioResampler(format="s16", layout="mono", rate=rate)

        def consume(frame):
            nonlocal copied
            if frame.pts is None or frame.time_base is None:
                raise ValueError("Audio decoding did not preserve source timestamps")
            start = round((float(frame.pts * frame.time_base) - origin) * rate)
            left, right = max(first, start), min(first + samples, start + frame.samples)
            if right > left:
                data = bytes(frame.planes[0])
                pcm[(left - first) * 2:(right - first) * 2] = data[(left - start) * 2:(right - start) * 2]
                copied += right - left
            return start >= first + samples

        finished = False
        for frame in container.decode(stream):
            for output in resampler.resample(frame):
                if consume(output):
                    finished = True
                    break
            if finished:
                break
        if not finished:
            for output in resampler.resample(None):
                consume(output)
    # Small codec padding is silence; gaps larger than 100ms are never
    # silently represented as though the recording had been decoded.
    if samples - copied > rate // 10:
        raise ValueError("Prepared audio did not decode the requested interval completely")
    with wave.open(str(target), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(pcm)
    return target


def transcribe_chunks(api, job, edition, track, folder):
    expected = job["payload"]["audioSha256"]
    headers = {"x-audio-sha256": expected, "x-cove-job-lease": job["lease_token"]}
    base = f"/pipeline/hosted-transcript/{edition['id']}/{track['id']}/chunks"
    plan = api.call(base, headers=headers)
    if plan.get("complete"):
        return plan["transcript"]
    duration = float(track["duration"])
    seconds = plan.get("chunkSeconds")
    if (seconds != 120 or not math.isfinite(duration) or duration <= 0
            or plan.get("identity", {}).get("audioSha256") != expected
            or abs(float(plan.get("duration", 0)) - duration) > .001
            or plan.get("count") != math.ceil(duration / seconds)):
        raise ValueError("Hosted chunk plan differs from the prepared recording")
    missing = plan.get("missing")
    if (not isinstance(missing, list) or missing != sorted(set(missing))
            or any(type(index) is not int or not 0 <= index < plan["count"] for index in missing)):
        raise ValueError("Invalid hosted chunk checkpoint")
    if not missing:
        return api.call(base, "POST", {}, headers=headers)
    audio = download(
        api.base + f"/audio/{edition['id']}/tracks/{track['id']}",
        folder / (expected + ".prepared.audio"),
        headers=api.headers, workers=2, chunk_size=2 * 1024 * 1024,
    )
    if sha256(audio) != expected:
        raise ValueError("Prepared audio checksum changed before chunk transcription")
    deadline = getattr(api, "deadline", None)
    if not isinstance(deadline, (int, float)):
        deadline = time.monotonic() + 200
    completed = None
    for index in missing:
        # Each invocation makes bounded progress; R2 survives timeouts. Leave
        # room for D1 checkpoint finalization inside the five-minute function.
        if completed is not None and time.monotonic() > deadline - 60:
            raise TranscriptionPending(completed)
        chunk = pcm_chunk(audio, folder / "asr-chunk.wav", index * seconds,
                          min(seconds, duration - index * seconds))
        try:
            response = api.call(base + f"/{index}", "POST", file=chunk,
                                headers={**headers, "x-content-sha256": sha256(chunk)})
        finally:
            chunk.unlink(missing_ok=True)
        if not response.get("cached"):
            completed = index
    return api.call(base, "POST", {}, headers=headers)

"""Size-check exact model snapshots before using ephemeral worker storage."""
from __future__ import annotations

import errno
import fnmatch
import os
import pathlib
import shutil
import threading


class ModelStorageUnavailable(RuntimeError):
    """The selected model needs an operator or a worker with more disk."""


MODEL_REPOSITORIES = {
    "base.en": "Systran/faster-whisper-base.en",
    "base": "Systran/faster-whisper-base",
    "tiny.en": "Systran/faster-whisper-tiny.en",
    "small.en": "Systran/faster-whisper-small.en",
    "small": "Systran/faster-whisper-small",
}
MODEL_FILES = (
    "config.json",
    "preprocessor_config.json",
    "model.bin",
    "tokenizer.json",
    "vocabulary.*",
)
# Leave room for the transcript, timing map, and other in-flight file writes.
RESERVE_BYTES = 96 * 1024 * 1024
_download_lock = threading.Lock()


def prepare_model(model: str, cache_dir: str | pathlib.Path) -> str:
    """Download only required files, pinned to the revision whose sizes we checked.

    Existing cache files are counted only when their sizes match. We never evict
    models that another invocation may be using, or silently choose a less
    accurate model to fit the disk. Network failures remain retryable.
    """
    if model not in MODEL_REPOSITORIES:
        raise ValueError(f"Unsupported Cove transcription model: {model}")
    # Hub environment flags are read at import time. Set this before the first
    # import, including CLI runs which do not use worker._prepare_runtime_cache.
    os.environ["HF_HUB_DISABLE_XET"] = "1"
    from huggingface_hub import HfApi, snapshot_download, try_to_load_from_cache

    cache = pathlib.Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    repo_id = MODEL_REPOSITORIES[model]
    # The thread lock covers concurrent invocations in a warm Python process;
    # flock also serializes download preflights across processes on the same disk.
    import fcntl
    with _download_lock, (cache / ".cove-download.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            info = HfApi(token=False).model_info(
                repo_id, files_metadata=True, timeout=20,
            )
            files = [
                file for file in info.siblings or []
                if any(fnmatch.fnmatchcase(file.rfilename, pattern) for pattern in MODEL_FILES)
            ]
            required = {"config.json", "model.bin", "tokenizer.json"}
            if not info.sha or not required.issubset({file.rfilename for file in files}):
                raise RuntimeError("Transcription model manifest is incomplete")
            missing_bytes = 0
            for file in files:
                if not isinstance(file.size, int) or file.size < 0:
                    raise RuntimeError("Transcription model manifest has no verified file size")
                cached = try_to_load_from_cache(
                    repo_id, file.rfilename, revision=info.sha, cache_dir=str(cache),
                )
                if not (
                    isinstance(cached, str)
                    and pathlib.Path(cached).is_file()
                    and pathlib.Path(cached).stat().st_size == file.size
                ):
                    missing_bytes += file.size

            free_bytes = shutil.disk_usage(cache).free
            if missing_bytes + RESERVE_BYTES > free_bytes:
                # /tmp is shared by warm invocations. Large models from an
                # earlier job can make a smaller model look unavailable even
                # though the older snapshot is no longer being used. Cove
                # schedules only one active alignment lease at a time.
                for other_repo in MODEL_REPOSITORIES.values():
                    if other_repo == repo_id:
                        continue
                    obsolete = cache / ("models--" + other_repo.replace("/", "--"))
                    if obsolete.is_dir():
                        shutil.rmtree(obsolete)
                free_bytes = shutil.disk_usage(cache).free
            if missing_bytes + RESERVE_BYTES > free_bytes:
                raise ModelStorageUnavailable(
                    f"BioSync model {model} needs {missing_bytes} download bytes plus "
                    f"{RESERVE_BYTES} reserve bytes; only {free_bytes} bytes are free. "
                    "Resume alignment on a worker with sufficient storage; playback is unaffected."
                )
            return snapshot_download(
                repo_id,
                revision=info.sha,
                cache_dir=str(cache),
                allow_patterns=[file.rfilename for file in files],
                max_workers=1,
                token=False,
            )
        except OSError as error:
            if error.errno == errno.ENOSPC:
                raise ModelStorageUnavailable(
                    "BioSync model download exhausted temporary storage; resume on a worker "
                    "with sufficient storage. Playback is unaffected."
                ) from error
            raise
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)

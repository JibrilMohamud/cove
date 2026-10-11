"""Runtime regressions without model downloads or live backend credentials."""
from __future__ import annotations

import errno
import io
import os
import pathlib
import tempfile
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from scripts.audio_pipeline import model_storage, runner, service


class ModelStorageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.cache = pathlib.Path(self.directory.name)
        self.files = [
            SimpleNamespace(rfilename=name, size=size)
            for name, size in [
                ("model.bin", 145_000_000), ("config.json", 100),
                ("tokenizer.json", 1000), ("vocabulary.txt", 500),
                ("README.md", 200), ("unneeded.bin", 500_000_000),
            ]
        ]
        self.info = SimpleNamespace(sha="a" * 40, siblings=self.files)
        self.api = self.enterContext(patch("huggingface_hub.HfApi"))
        self.api.return_value.model_info.return_value = self.info
        self.cached = self.enterContext(patch("huggingface_hub.try_to_load_from_cache", return_value=None))
        self.download = self.enterContext(patch("huggingface_hub.snapshot_download", return_value="/snapshot"))
        self.disk = self.enterContext(patch.object(model_storage.shutil, "disk_usage"))
        self.disk.return_value.free = 400 * 1024 * 1024

    def prepare(self, model="base.en"):
        return model_storage.prepare_model(model, self.cache)

    def test_download_is_pinned_and_excludes_unneeded_files(self):
        self.assertEqual(self.prepare(), "/snapshot")
        arguments = self.download.call_args.kwargs
        self.assertEqual(arguments["revision"], self.info.sha)
        self.assertEqual(set(arguments["allow_patterns"]), {"config.json", "model.bin", "tokenizer.json", "vocabulary.txt"})
        self.assertEqual(arguments["max_workers"], 1)
        self.assertFalse(arguments["token"])

    def test_oversized_fallback_is_rejected_before_download(self):
        self.files[0].size = 484_000_000
        with self.assertRaises(model_storage.ModelStorageUnavailable):
            self.prepare("small.en")
        self.download.assert_not_called()

    def test_reserve_is_preserved_even_if_model_alone_fits(self):
        self.disk.return_value.free = 146_000_000
        with self.assertRaises(model_storage.ModelStorageUnavailable):
            self.prepare()
        self.download.assert_not_called()

    def test_complete_cached_files_do_not_need_download_space(self):
        paths = {}
        for file in self.files[:4]:
            path = self.cache / file.rfilename
            with path.open("wb") as stream:
                stream.truncate(file.size)
            paths[file.rfilename] = str(path)
        self.cached.side_effect = lambda repo, filename, **kwargs: paths.get(filename)
        self.disk.return_value.free = model_storage.RESERVE_BYTES
        self.assertEqual(self.prepare(), "/snapshot")

    def test_truncated_cache_file_does_not_count_as_complete(self):
        path = self.cache / "model.bin"
        path.write_bytes(b"incomplete")
        self.cached.return_value = str(path)
        self.disk.return_value.free = model_storage.RESERVE_BYTES
        with self.assertRaises(model_storage.ModelStorageUnavailable):
            self.prepare()
        self.download.assert_not_called()

    def test_unknown_size_does_not_start_unbounded_download(self):
        self.files[0].size = None
        with self.assertRaisesRegex(RuntimeError, "verified file size"):
            self.prepare()
        self.download.assert_not_called()

    def test_missing_required_file_does_not_download(self):
        self.info.siblings = self.files[1:]
        with self.assertRaisesRegex(RuntimeError, "incomplete"):
            self.prepare()
        self.download.assert_not_called()

    def test_disk_exhaustion_during_download_is_reviewable(self):
        self.download.side_effect = OSError(errno.ENOSPC, "No space left")
        with self.assertRaises(model_storage.ModelStorageUnavailable):
            self.prepare()

    def test_network_failure_remains_retryable(self):
        self.download.side_effect = TimeoutError("network timeout")
        with self.assertRaises(TimeoutError):
            self.prepare()


class PipelineTests(unittest.TestCase):
    def test_capacity_failure_finishes_only_alignment_as_review(self):
        job = {"id": "align-canary", "kind": "align", "lease_token": "test-lease"}
        api = Mock()
        api.call.side_effect = [job, {}]
        with tempfile.TemporaryDirectory() as cache:
            args = SimpleNamespace(cache=cache, no_discovery=True, kind="align", minutes=1, max_jobs=1, threads=1)
            with patch.object(runner, "Api", return_value=api), patch.object(
                runner, "process", side_effect=model_storage.ModelStorageUnavailable("model exceeds storage")
            ), patch.dict(os.environ), redirect_stdout(io.StringIO()):
                runner.run({}, args)
        api.finish.assert_called_once_with(job, "review", "model exceeds storage")
        self.assertEqual([call.args[0] for call in api.call.call_args_list], ["/pipeline/claim", "/audio-status"])

    def test_health_returns_diagnostics_instead_of_execution_mode_string(self):
        with patch.object(service, "pipeline_config", return_value={"configured": True}):
            response = TestClient(service.app).get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertIs(response.json()["ok"], True)
        self.assertIs(response.json()["persistenceBackend"], True)
        self.assertIn(response.json()["executionMode"], {"direct", "queue"})

    def test_health_fails_closed_when_credentials_are_missing(self):
        with patch.object(service, "pipeline_config", side_effect=RuntimeError("missing private config")):
            response = TestClient(service.app).get("/health")
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private config", response.text)


if __name__ == "__main__":
    unittest.main()

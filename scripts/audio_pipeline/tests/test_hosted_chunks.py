"""Chunk boundaries, pinned identity, and durable progress regressions."""
import pathlib
import struct
import tempfile
import unittest
import wave
from unittest.mock import Mock, patch

from scripts.audio_pipeline import hosted_chunks, runner


class PcmChunkTests(unittest.TestCase):
    def test_seek_and_trim_keep_exact_samples_across_chunk_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = pathlib.Path(directory) / "source.wav", pathlib.Path(directory) / "chunk.wav"
            # A different constant in each second reveals seek offset mistakes.
            with wave.open(str(source), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                for second in range(242):
                    audio.writeframesraw(struct.pack("<h", second + 1) * 16000)
            hosted_chunks.pcm_chunk(source, target, 120, 120)
            with wave.open(str(target), "rb") as audio:
                self.assertEqual(audio.getnframes(), 120 * 16000)
                self.assertEqual(struct.unpack("<h", audio.readframes(1))[0], 121)
                audio.setpos(119 * 16000)
                self.assertEqual(struct.unpack("<h", audio.readframes(1))[0], 240)
            hosted_chunks.pcm_chunk(source, target, 240, 1.5)
            with wave.open(str(target), "rb") as audio:
                self.assertEqual(audio.getnframes(), 24000)
                self.assertEqual(struct.unpack("<h", audio.readframes(1))[0], 241)

    def test_truncated_recording_cannot_be_padded_into_a_full_chunk(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "source.wav"
            with wave.open(str(source), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(b"\0\0" * 16000)
            with self.assertRaisesRegex(ValueError, "completely"):
                hosted_chunks.pcm_chunk(source, source.with_name("chunk.wav"), 0, 120)


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.hash = "a" * 64
        self.edition = {"id": "pg-1"}
        self.track = {"id": "01", "duration": 360}
        self.job = {"id": "align-1", "kind": "align", "lease_token": "lease", "payload": {"audioSha256": self.hash}}
        self.plan = {"identity": {"audioSha256": self.hash}, "duration": 360,
                     "count": 3, "chunkSeconds": 120, "missing": [1, 2]}

    def test_resume_skips_previously_cached_chunks_and_checkpoints_new_progress(self):
        api = Mock()
        api.base = "https://backend/api/fore"
        api.headers = {}
        api.deadline = 150
        api.call.side_effect = [self.plan, {"cached": False, "index": 1}]
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            def decode(source, target, offset, duration):
                target.write_bytes(b"wav")
                return target
            with patch.object(hosted_chunks, "download", return_value=root / "audio"), patch.object(
                hosted_chunks, "sha256", return_value=self.hash
            ), patch.object(hosted_chunks, "pcm_chunk", side_effect=decode) as decoder, patch.object(
                hosted_chunks.time, "monotonic", return_value=100
            ):
                with self.assertRaises(hosted_chunks.TranscriptionPending) as error:
                    hosted_chunks.transcribe_chunks(api, self.job, self.edition, self.track, root)
            self.assertEqual(error.exception.index, 1)
            self.assertEqual(decoder.call_args.args[2:], (120, 120))
            self.assertFalse((root / "asr-chunk.wav").exists())
            self.assertEqual(api.call.call_args.args[0], "/pipeline/hosted-transcript/pg-1/01/chunks/1")

    def test_complete_checkpoint_needs_no_audio_download(self):
        api = Mock()
        api.call.return_value = {"complete": True, "transcript": {"words": []}}
        with patch.object(hosted_chunks, "download", side_effect=AssertionError("No duplicate download")):
            result = hosted_chunks.transcribe_chunks(api, self.job, self.edition, self.track, pathlib.Path("/tmp"))
        self.assertEqual(result, {"words": []})

    def test_changed_source_hash_cannot_submit_pcm(self):
        api = Mock()
        api.base = "https://backend/api/fore"
        api.headers = {}
        api.call.return_value = self.plan
        with patch.object(hosted_chunks, "download", return_value=pathlib.Path("/tmp/audio")), patch.object(
            hosted_chunks, "sha256", return_value="b" * 64
        ), patch.object(hosted_chunks, "pcm_chunk") as decoder:
            with self.assertRaisesRegex(ValueError, "checksum changed"):
                hosted_chunks.transcribe_chunks(api, self.job, self.edition, self.track, pathlib.Path("/tmp"))
        decoder.assert_not_called()

    def test_runner_reports_progress_without_counting_it_as_failure(self):
        api = Mock()
        api.call.side_effect = [self.job, {}]
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as directory, patch.object(runner, "Api", return_value=api), patch.object(
            runner, "process", side_effect=hosted_chunks.TranscriptionPending(2)
        ):
            runner.run({}, SimpleNamespace(cache=directory, no_discovery=True, kind="align", minutes=1, max_jobs=1, threads=1))
        self.assertEqual(api.finish.call_args.args[1], "checkpoint")
        self.assertEqual(api.finish.call_args.kwargs, {"checkpoint_index": 2})


if __name__ == "__main__":
    unittest.main()

import hashlib
import json
import os
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from . import biosync_production_owner_transport as t


class ProductionBioSyncTransportTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "COVE_BIOSYNC_PROD_OWNER_MODE": "1",
            "COVE_BIOSYNC_PROD_D1_READ_TOKEN": "d" * 32,
            "COVE_BIOSYNC_PROD_R2_TOKEN": "r" * 32,
            "COVE_BIOSYNC_PROD_CLIENT_SECRET": "a" * 64,
        }, clear=True)
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_exact_read_and_mutation_denial(self):
        payload = lambda s: json.dumps({"sql": s, "params": []}).encode()
        self.assertEqual(t.authorize("POST", t.D1, payload("SELECT 1"), True), "d" * 32)
        for sql in ("UPDATE audio_jobs SET status='done'", "SELECT 1; DELETE FROM audio_jobs",
                    "SELECT 1 /*comment*/", "WITH x AS (SELECT 1) SELECT 1"):
            with self.assertRaises(RuntimeError):
                t.authorize("POST", t.D1, payload(sql), True)
        with self.assertRaises(RuntimeError):
            t.authorize("POST", t.D1.replace(t.PRIMARY, "foreign"), payload("SELECT 1"), True)

    def test_scope_and_map_digest(self):
        content = b"x" * 512
        sha = hashlib.sha256(content).hexdigest()
        url = t.R2 + "/biosync/maps/" + sha + ".json"
        self.assertEqual(t.authorize("PUT", url, content, False), "r" * 32)
        for wrong in (t.R2 + "/other", url.replace(t.BUCKET, "other"), url+"?x=1"):
            with self.assertRaises(RuntimeError):
                t.authorize("PUT", wrong, content, False)
        with self.assertRaises(RuntimeError):
            t.authorize("PUT", url, b"y" * 512, False)

    def test_s3_transport_keeps_bucket_scope_and_never_sends_raw_bearer(self):
        now = datetime(2026, 11, 24, 12, 0, tzinfo=timezone.utc)
        req = t.s3_signed_request("GET", "", {"prefix": "biosync/text/", "max-keys": "1", "list-type": "2"},
                                  None, "r" * 32, now)
        self.assertEqual(req.full_url, f"https://{t.R2_HOST}/{t.BUCKET}?list-type=2&max-keys=1&prefix=biosync%2Ftext%2F")
        authorization = req.get_header("Authorization")
        self.assertIn(f"Credential={t.R2_ACCESS_KEY_ID}/20261124/auto/s3/aws4_request", authorization)
        self.assertIn("SignedHeaders=host;x-amz-content-sha256;x-amz-date", authorization)
        self.assertNotIn("r" * 32, authorization)
        changed = t.s3_signed_request("GET", "", {"prefix": "biosync/text/", "max-keys": "1", "list-type": "2"},
                                      None, "s" * 32, now)
        self.assertNotEqual(authorization, changed.get_header("Authorization"))

    def test_r2_list_envelope_and_wrong_bucket_denial(self):
        xml = (f'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
               f'<Name>{t.BUCKET}</Name><Prefix>biosync/text/</Prefix>'
               '<Contents><Key>biosync/text/one.epub</Key></Contents></ListBucketResult>').encode()
        with patch.object(t, "s3_call", return_value=xml) as call:
            result = t.s3_list("biosync/text/", 1, "r" * 32)
            self.assertEqual(result["result"], [{"key": "biosync/text/one.epub"}])
            call.assert_called_once_with("GET", "", {"list-type": "2", "prefix": "biosync/text/", "max-keys": "1"}, None, "r" * 32)
        with patch.object(t, "s3_call", return_value=xml.replace(t.BUCKET.encode(), b"wrong")):
            with self.assertRaises(RuntimeError):
                t.s3_list("biosync/text/", 1, "r" * 32)

    def test_checked_map_upload_uses_s3_not_rest(self):
        content = b"x" * 512
        sha = hashlib.sha256(content).hexdigest()
        with patch.object(t, "s3_call", return_value=b"") as call:
            result = t.request("PUT", t.R2 + "/biosync/maps/" + sha + ".json", content)
            self.assertTrue(json.loads(result)["success"])
            call.assert_called_once_with("PUT", "biosync/maps/" + sha + ".json", {}, content, "r" * 32)

    def test_owner_commit_only_passes_client_secret_and_exact_command(self):
        from subprocess import CompletedProcess
        payload = {"editionId": "pg-19504", "trackId": "02", "jobId": "align-test",
                   "mapSha256": "a" * 64}
        receipt = {**payload, "schema": "cove.owner-biosync-checked-publication.v1",
                   "committed": True, "replay": True}
        with patch.object(t.subprocess, "run", return_value=CompletedProcess(
                args=[], returncode=0, stdout=json.dumps(receipt), stderr="")) as run:
            self.assertEqual(t.commit("pg-19504", "02", "align-test", "a" * 64), receipt)
            args, kwargs = run.call_args
            self.assertEqual(args[0][0], "node")
            self.assertEqual(json.loads(kwargs["input"]), payload)
            self.assertEqual(set(kwargs["env"]), {"PATH", "COVE_BIOSYNC_PROD_CLIENT_SECRET"})
            self.assertEqual(kwargs["env"]["COVE_BIOSYNC_PROD_CLIENT_SECRET"], "a" * 64)
        with patch.object(t.subprocess, "run", return_value=CompletedProcess(
                args=[], returncode=1, stdout="", stderr="biosync_owner_edge_or_transport_http_403")) as run:
            with self.assertRaisesRegex(RuntimeError, "biosync_owner_edge_or_transport_http_403"):
                t.commit("pg-19504", "02", "align-test", "a" * 64)
            self.assertEqual(run.call_count, 1)

    def test_no_legacy_token_or_missing_secrets(self):
        with patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "broad"}):
            with self.assertRaises(RuntimeError):
                t.require_credentials()
        with patch.dict(os.environ, {"COVE_BIOSYNC_PROD_R2_TOKEN": ""}):
            with self.assertRaises(RuntimeError):
                t.require_credentials()


if __name__ == "__main__":
    unittest.main()

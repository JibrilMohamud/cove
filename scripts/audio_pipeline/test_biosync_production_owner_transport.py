import hashlib
import json
import os
import unittest
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

    def test_no_legacy_token_or_missing_secrets(self):
        with patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "broad"}):
            with self.assertRaises(RuntimeError):
                t.require_credentials()
        with patch.dict(os.environ, {"COVE_BIOSYNC_PROD_R2_TOKEN": ""}):
            with self.assertRaises(RuntimeError):
                t.require_credentials()


if __name__ == "__main__":
    unittest.main()

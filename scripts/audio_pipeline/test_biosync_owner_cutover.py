"""Offline security regression for the scheduled BioSync to owner-command cutover."""
from __future__ import annotations

import json
import os
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from scripts.audio_pipeline import biosync_canary as canary

HASH = "a" * 64


class StubResponse:
    status = 200

    def __init__(self, receipt):
        self.payload = json.dumps(receipt).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, _limit=None):
        return self.payload


class StubOpener:
    def __init__(self, receipt):
        self.receipt = receipt
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append(request)
        return StubResponse(self.receipt)


class OwnerCutoverTests(unittest.TestCase):
    def test_d1_sql_is_select_only(self):
        for illegal in (
            "INSERT INTO audio_timing VALUES(1)",
            "UPDATE audio_jobs SET status='done'",
            "DELETE FROM audio_timing",
            "SELECT 1; UPDATE audio_jobs SET status='done'",
            "WITH x AS(SELECT 1) UPDATE audio_jobs SET status='done'",
        ):
            with self.subTest(sql=illegal):
                with self.assertRaisesRegex(RuntimeError, "SELECT-only"):
                    canary.query(illegal)

    def test_no_cloudflare_token_leaks_to_other_origins(self):
        with patch.dict(os.environ, {"COVE_BIOSYNC_D1_READ_TOKEN": "fake"}):
            with self.assertRaisesRegex(RuntimeError, "host is not authorized"):
                canary.authorized_request(
                    "POST",
                    "https://evil.example/client/v4/accounts/" + canary.ACCOUNT +
                    "/d1/database/" + canary.DATABASE + "/query", b"{}"
                )
            with self.assertRaisesRegex(RuntimeError, "read-only"):
                canary.authorized_request(
                    "DELETE",
                    canary.BASE + "/d1/database/" + canary.DATABASE + "/query"
                )
            with self.assertRaisesRegex(RuntimeError, "cannot execute writes"):
                canary.authorized_request(
                    "POST",
                    canary.BASE + "/d1/database/" + canary.DATABASE + "/query",
                    json.dumps({"sql": "UPDATE audio_jobs SET status='done'", "params": []}).encode(),
                    json_body=True
                )
        with self.assertRaisesRegex(RuntimeError, "allowlisted"):
            canary.authorized_request("PUT", canary.BASE + "/tokens/key")

    def test_owner_receipt_identity_and_exact_request(self):
        payload = dict(
            schema="cove.owner-biosync-checked-publication.v1",
            editionId="pg-19504", trackId="02", jobId="job_owner_02",
            mapSha256=HASH, committed=True, replay=False,
        )
        opener = StubOpener(payload)
        with patch.dict(os.environ, {
            "COVE_BIOSYNC_QA_GATEWAY_URL": "https://stage.example",
            "COVE_BIOSYNC_QA_CLIENT_SECRET": "NaN",
        }), patch.object(canary.urllib.request, "build_opener", return_value=opener):
            out = canary.commit_checked_map_to_owner(
                "pg-19504", "02", "job_owner_02", HASH
            )
        self.assertEqual(out, payload)
        request, = opener.requests
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.full_url,
            "https://stage.example/biosync/publish-checked")
        self.assertNotIn("sql", json.loads(request.data))
        self.assertEqual(json.loads(request.data)["mapSha256"], HASH)

        for replacement in [
            {"committed": False}, {"mapSha256": "b" * 64},
            {"replay": "false"}, {"schema": "untrusted"}
        ]:
            opener = StubOpener({**payload, **replacement})
            with patch.dict(os.environ, {
                "COVE_BIOSYNC_QA_GATEWAY_URL": "https://stage.example",
                "COVE_BIOSYNC_QA_CLIENT_SECRET": "NaN",
            }), patch.object(canary.urllib.request, "build_opener", return_value=opener):
                with self.assertRaisesRegex(RuntimeError, "receipt"):
                    canary.commit_checked_map_to_owner(
                        "pg-19504", "02", "job_owner_02", HASH
                    )

    def test_owner_outage_and_credentials_fail_closed(self):
        with patch.dict(os.environ, {
            "COVE_BIOSYNC_QA_GATEWAY_URL": "http://insecure.example",
            "COVE_BIOSYNC_QA_CLIENT_SECRET": "NaN",
        }):
            with self.assertRaisesRegex(RuntimeError, "HTTPS"):
                canary.commit_checked_map_to_owner("pg-19504", "02", "job_owner_02", HASH)
        with patch.dict(os.environ, {
            "COVE_BIOSYNC_QA_GATEWAY_URL": "https://stage.example",
            "COVE_BIOSYNC_QA_CLIENT_SECRET": "not_a_qa_secret",
        }):
            with self.assertRaisesRegex(RuntimeError, "ephemeral QA"):
                canary.commit_checked_map_to_owner("pg-19504", "02", "job_owner_02", HASH)
        with patch.dict(os.environ, {
            "COVE_BIOSYNC_QA_GATEWAY_URL": "https://stage.example",
            "COVE_BIOSYNC_QA_CLIENT_SECRET": "NaN",
        }):
            class FailedOpener:
                def open(self, request, timeout=None):
                    raise HTTPError(request.full_url, 503, "offline", {}, None)
            with patch.object(canary.urllib.request, "build_opener", return_value=FailedOpener()):
                with self.assertRaisesRegex(RuntimeError, "HTTP 503"):
                    canary.commit_checked_map_to_owner(
                        "pg-19504", "02", "job_owner_02", HASH
                    )


if __name__ == "__main__":
    unittest.main()

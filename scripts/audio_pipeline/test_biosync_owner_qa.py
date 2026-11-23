"""Offline security regression for the scheduled BioSync to owner-command cutover."""
from __future__ import annotations

import json
import os
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from scripts.audio_pipeline import biosync_owner_qa as canary

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
        with patch.dict(os.environ, {"COVE_BIOSYNC_R2_TOKEN": "fake"}):
            with self.assertRaisesRegex(RuntimeError, "dedicated QA bucket"):
                canary.authorized_request(
                    "GET", canary.BASE + "/r2/buckets/other-qa-bucket/objects"
                )

    def test_isolated_account_scope(self):
        self.assertEqual(canary.ACCOUNT, "f51e8ccbc394e2d6016ff8c2c303d54b")
        self.assertEqual(canary.QA_DATABASES, {"4e17ba6f-444f-4245-801a-a7d4969045b0"})
        self.assertNotIn("4bd657ac-8789-403e-a28c-93aba8d0a989", canary.QA_DATABASES)
        self.assertEqual(canary.QA_BUCKET, "cove-owner-biosync-qa")

    def test_owner_receipt_identity_and_exact_request(self):
        payload = dict(
            schema="cove.owner-biosync-checked-publication.v1",
            editionId="pg-19504", trackId="02", jobId="job_owner_02",
            mapSha256=HASH, committed=True, replay=False,
        )
        opener = StubOpener(payload)
        with patch.dict(os.environ, {
            "COVE_BIOSYNC_QA_GATEWAY_URL": "https://cove-biosync-gateway.cove-qa-reads.workers.dev",
            "COVE_BIOSYNC_QA_CLIENT_SECRET": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        }), patch.object(canary.urllib.request, "build_opener", return_value=opener):
            out = canary.commit_checked_map_to_owner(
                "pg-19504", "02", "job_owner_02", HASH
            )
        self.assertEqual(out, payload)
        request, = opener.requests
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.full_url,
            "https://cove-biosync-gateway.cove-qa-reads.workers.dev/biosync/publish-checked")
        self.assertNotIn("sql", json.loads(request.data))
        self.assertEqual(json.loads(request.data)["mapSha256"], HASH)

        for replacement in [
            {"committed": False}, {"mapSha256": "b" * 64},
            {"replay": "false"}, {"schema": "untrusted"}
        ]:
            opener = StubOpener({**payload, **replacement})
            with patch.dict(os.environ, {
                "COVE_BIOSYNC_QA_GATEWAY_URL": "https://cove-biosync-gateway.cove-qa-reads.workers.dev",
                "COVE_BIOSYNC_QA_CLIENT_SECRET": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            }), patch.object(canary.urllib.request, "build_opener", return_value=opener):
                with self.assertRaisesRegex(RuntimeError, "receipt"):
                    canary.commit_checked_map_to_owner(
                        "pg-19504", "02", "job_owner_02", HASH
                    )

    def test_owner_gateway_must_remain_in_independent_qa_account(self):
        with patch.dict(os.environ, {
            "COVE_BIOSYNC_QA_GATEWAY_URL": "https://untrusted.example",
            "COVE_BIOSYNC_QA_CLIENT_SECRET": "f" * 64,
        }):
            with self.assertRaisesRegex(RuntimeError, "isolated Cove QA"):
                canary.commit_checked_map_to_owner("pg-19504", "02", "job_owner_02", HASH)

    def test_owner_outage_and_credentials_fail_closed(self):
        with patch.dict(os.environ, {
            "COVE_BIOSYNC_QA_GATEWAY_URL": "http://insecure.example",
            "COVE_BIOSYNC_QA_CLIENT_SECRET": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        }):
            with self.assertRaisesRegex(RuntimeError, "HTTPS"):
                canary.commit_checked_map_to_owner("pg-19504", "02", "job_owner_02", HASH)
        with patch.dict(os.environ, {
            "COVE_BIOSYNC_QA_GATEWAY_URL": "https://cove-biosync-gateway.cove-qa-reads.workers.dev",
            "COVE_BIOSYNC_QA_CLIENT_SECRET": "not_a_qa_secret",
        }):
            with self.assertRaisesRegex(RuntimeError, "ephemeral QA"):
                canary.commit_checked_map_to_owner("pg-19504", "02", "job_owner_02", HASH)
        with patch.dict(os.environ, {
            "COVE_BIOSYNC_QA_GATEWAY_URL": "https://cove-biosync-gateway.cove-qa-reads.workers.dev",
            "COVE_BIOSYNC_QA_CLIENT_SECRET": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        }):
            class FailedOpener:
                def open(self, request, timeout=None):
                    raise HTTPError(request.full_url, 503, "offline", {}, None)
            with patch.object(canary.urllib.request, "build_opener", return_value=FailedOpener()):
                with self.assertRaisesRegex(RuntimeError, "HTTP 503"):
                    canary.commit_checked_map_to_owner(
                        "pg-19504", "02", "job_owner_02", HASH
                    )



class ReviewedShortTrackSelectionTests(unittest.TestCase):
    def _select(self, review_enabled: bool, transcript_present: bool = True, epub_present: bool = True):
        seen = []
        candidate = {
            "job_id": "align-qa-short-reviewed-001",
            "edition_id": "pg-qa-short-reviewed-001",
            "track_id": "01",
            "audio_sha": "a" * 64,
            "epub_sha": "b" * 64,
        }
        prefix = "biosync/transcripts/cloudflare-whisper-v1/"
        epub_prefix = "biosync/text/"
        transcript_rows = [{
            "key": prefix + candidate["audio_sha"] + ".json"
        }] if transcript_present else []
        epub_rows = [{
            "key": epub_prefix + candidate["epub_sha"] + ".epub"
        }] if epub_present else []

        def fake_request(method, url, *args, **kwargs):
            self.assertEqual(method, "GET")
            self.assertIn("/r2/buckets/" + canary.QA_BUCKET + "/objects", url)
            rows = epub_rows if "biosync%2Ftext%2F" in url else transcript_rows
            return json.dumps({"success": True, "result": rows}).encode()

        def fake_query(sql):
            seen.append(sql)
            self.assertTrue(sql.startswith("SELECT "))
            self.assertNotIn("UPDATE ", sql)
            self.assertIn("j.attempts<6", sql)
            self.assertIn("j.lease_token IS NULL", sql)
            self.assertIn("j.lease_until IS NULL", sql)
            self.assertIn("<=240", sql)
            self.assertIn("m.map_sha256 IS NULL", sql)
            if "('queued','review')" in sql:
                return [candidate]
            return []

        previous = (canary.EDITION, canary.TRACK, canary.JOB)
        try:
            with patch.dict(os.environ, {
                "BIOSYNC_RECHECK_REVIEW": "1" if review_enabled else "",
            }), patch.object(canary, "BUCKET", canary.QA_BUCKET), patch.object(
                canary, "authorized_request", side_effect=fake_request
            ), patch.object(canary, "query", side_effect=fake_query):
                selected = canary.choose_queued_short_track()
                if selected:
                    self.assertEqual(canary.EDITION, candidate["edition_id"])
                    self.assertEqual(canary.TRACK, candidate["track_id"])
                    self.assertEqual(canary.JOB, candidate["job_id"])
        finally:
            canary.EDITION, canary.TRACK, canary.JOB = previous
        return selected, seen

    def test_held_review_never_automatically_selected(self):
        selected, sql = self._select(review_enabled=False)
        self.assertFalse(selected)
        self.assertEqual(len(sql), 1)
        self.assertIn("j.status IN ('queued')", sql[0])
        self.assertNotIn("'review'", sql[0])

    def test_explicit_qa_recheck_still_requires_cached_source(self):
        selected, sql = self._select(review_enabled=True, transcript_present=True)
        self.assertTrue(selected)
        self.assertEqual(len(sql), 1)
        self.assertIn("j.status IN ('queued','review')", sql[0])
        unavailable, _ = self._select(review_enabled=True, transcript_present=False)
        self.assertFalse(unavailable)
        missing_epub, _ = self._select(review_enabled=True, epub_present=False)
        self.assertFalse(missing_epub)

    def test_direct_job_invocation_never_bypasses_review_hold_or_active_lease(self):
        # main() can also run with an explicitly selected job. The review
        # hold must apply there, not only to the short auto-selector.
        env = {
            "COVE_BIOSYNC_D1_READ_TOKEN": "qa-only-read",
            "COVE_BIOSYNC_R2_TOKEN": "qa-only-r2",
            "COVE_BIOSYNC_QA_GATEWAY_URL": "https://cove-biosync-gateway.cove-qa-reads.workers.dev",
            "COVE_BIOSYNC_QA_CLIENT_SECRET": "f" * 64,
            "BIOSYNC_RECHECK_REVIEW": "",
            "BIOSYNC_AUTO_SHORT": "",
        }
        for status, reason in [
            ("review", "requires explicit QA recheck"),
            ("running", "active BioSync job lease"),
            ("failed", "not eligible"),
        ]:
            row = {
                "book_id": "qa-only-book",
                "epub_sha256": "b" * 64,
                "language": "en",
                "tracks_json": json.dumps([{"id": canary.TRACK, "sha256": "a" * 64, "duration": 30}]),
                "status": status,
            }
            with self.subTest(status=status), patch.dict(os.environ, env), patch.object(
                canary, "DATABASE", next(iter(canary.QA_DATABASES))
            ), patch.object(canary, "BUCKET", canary.QA_BUCKET), patch.object(
                canary, "query", return_value=[row]
            ) as lookup, patch.object(canary, "authorized_request") as network:
                with self.assertRaisesRegex(RuntimeError, reason):
                    canary.main()
                self.assertEqual(lookup.call_count, 1)
                network.assert_not_called()


if __name__ == "__main__":
    unittest.main()

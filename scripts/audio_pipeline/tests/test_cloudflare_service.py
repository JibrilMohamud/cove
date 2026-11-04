"""Mocked boundary tests: no backend requests, media downloads, or model inference."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from scripts.audio_pipeline import cloudflare_service


class CloudflareAudioServiceTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(cloudflare_service.app)
        self.env = patch.dict(
            os.environ,
            {
                "COVE_AUDIO_EXECUTION_SECRET": "s" * 40,
                "FORE_BACKEND_URL": "https://api.covereads.com",
                "FORE_BACKEND_TOKEN": "g" * 40,
                "FORE_SERVICE_TOKEN": "p" * 40,
            },
        )
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_missing_or_wrong_secret_never_executes(self):
        with patch.object(cloudflare_service, "execute_pipeline") as engine:
            self.assertEqual(self.client.post("/run", json={}).status_code, 401)
            self.assertEqual(
                self.client.post("/run", json={}, headers={"x-cove-execution-secret": "wrong"}).status_code,
                401,
            )
            engine.assert_not_called()

    def test_health_denies_missing_secrets(self):
        self.assertEqual(self.client.get("/health").status_code, 200)
        with patch.dict(os.environ, {"FORE_SERVICE_TOKEN": ""}):
            self.assertEqual(self.client.get("/health").status_code, 503)

    def test_queue_delivery_runs_original_engine(self):
        payload = {
            "kind": "align",
            "execution_mode": "direct",
            "max_jobs": 1,
            "minutes": 4,
            "no_discovery": True,
            "threads": 4,
        }
        with patch.object(cloudflare_service, "execute_pipeline", return_value=True) as engine:
            response = self.client.post("/run", json=payload, headers={"x-cove-execution-secret": "s" * 40})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["executed"], True)
            self.assertEqual(engine.call_args.args[0].kind, "align")

    def test_budget_deferral_is_explicit(self):
        with patch.object(cloudflare_service, "execute_pipeline", return_value=False):
            response = self.client.post(
                "/run",
                json={"execution_mode": "direct"},
                headers={"x-cove-execution-secret": "s" * 40},
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["executed"], False)
            self.assertEqual(response.json()["skipped"], "compute_budget")

    def test_invalid_job_cannot_run(self):
        with patch.object(cloudflare_service, "execute_pipeline") as engine:
            invalid = self.client.post(
                "/run",
                json={"kind": "track", "max_jobs": 1000},
                headers={"x-cove-execution-secret": "s" * 40},
            )
            self.assertEqual(invalid.status_code, 400)
            not_direct = self.client.post(
                "/run",
                json={"execution_mode": "queue"},
                headers={"x-cove-execution-secret": "s" * 40},
            )
            self.assertEqual(not_direct.status_code, 400)
            engine.assert_not_called()

    def test_error_is_retryable_without_secret_leakage(self):
        with patch.object(cloudflare_service, "execute_pipeline", side_effect=RuntimeError("backend down")):
            response = self.client.post(
                "/run",
                json={"kind": "track", "execution_mode": "direct"},
                headers={"x-cove-execution-secret": "s" * 40},
            )
            self.assertEqual(response.status_code, 503)
            self.assertNotIn("backend down", response.text)


if __name__ == "__main__":
    unittest.main()

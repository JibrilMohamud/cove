"""Separate the live scheduled BioSync producer from synthetic owner QA.

The production canary and its hourly workflow must remain operational until a
protected production-equivalent replacement, real rights authority and rollback
have been independently certified. QA still verifies typed owner operations in
the physically separate Cove QA account; a synthetic success is not cutover.
"""
import unittest
from unittest.mock import patch

from scripts.audio_pipeline import biosync_canary, biosync_owner_qa
from scripts.audio_pipeline.test_biosync_owner_qa import OwnerCutoverTests  # noqa: F401


class LiveBioSyncContinuity(unittest.TestCase):
    def test_existing_production_publisher_is_not_replaced_by_qa(self):
        self.assertEqual(
            biosync_canary.ACCOUNT,
            "d26430caa63ec55f6612e32f36aca5e9",
        )
        self.assertEqual(
            biosync_canary.DATABASE,
            "4bd657ac-8789-403e-a28c-93aba8d0a989",
        )
        self.assertEqual(biosync_canary.BUCKET, "cove-production-media")
        self.assertIsNot(biosync_canary.main, biosync_owner_qa.main)
        self.assertIsNot(biosync_canary.query, biosync_owner_qa.query)

    def test_production_has_no_legacy_fallback(self):
        with patch.dict("os.environ", {"COVE_BIOSYNC_PROD_OWNER_MODE": "0"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "requires owner mode"):
                biosync_canary.main()
        with patch.object(biosync_canary.owner_transport, "request", return_value=b"scoped") as send:
            self.assertEqual(biosync_canary.authorized_request("GET", "fixed"), b"scoped")
            send.assert_called_once_with("GET", "fixed", None, json_body=False)

    def test_owner_client_is_confined_to_independent_synthetic_qa(self):
        self.assertEqual(
            biosync_owner_qa.ACCOUNT,
            "f51e8ccbc394e2d6016ff8c2c303d54b",
        )
        self.assertEqual(
            biosync_owner_qa.QA_DATABASES,
            {"4e17ba6f-444f-4245-801a-a7d4969045b0"},
        )
        self.assertEqual(biosync_owner_qa.QA_BUCKET, "cove-owner-biosync-qa")


if __name__ == "__main__":
    unittest.main()

"""Compatibility entrypoint tests must exercise the canonical QA-only client."""
import unittest

from scripts.audio_pipeline import biosync_canary, biosync_owner_qa
from scripts.audio_pipeline.test_biosync_owner_qa import OwnerCutoverTests  # noqa: F401


class NoSecondBiosyncWriter(unittest.TestCase):
    def test_legacy_entrypoint_is_exact_qa_owner_client(self):
        self.assertIs(biosync_canary.main, biosync_owner_qa.main)
        self.assertIs(biosync_canary.query, biosync_owner_qa.query)
        self.assertIs(
            biosync_canary.commit_checked_map_to_owner,
            biosync_owner_qa.commit_checked_map_to_owner,
        )
        self.assertEqual(
            biosync_canary.ACCOUNT, "f51e8ccbc394e2d6016ff8c2c303d54b"
        )
        self.assertEqual(
            biosync_canary.QA_DATABASES,
            {"4e17ba6f-444f-4245-801a-a7d4969045b0"},
        )


if __name__ == "__main__":
    unittest.main()

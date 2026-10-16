#!/usr/bin/env python3
import hashlib
import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

path = pathlib.Path(__file__).with_name("external-source-intake.py")
spec = importlib.util.spec_from_file_location("external_soundtrack_intake", path)
lib = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lib)
AUDIO = b"test-only audio fixture; not a real recording"

def item(provider="fma"):
    page = ("https://freemusicarchive.org/music/Composer/Album/Quiet_Track/" if provider=="fma"
            else "https://musopen.org/music/12345/quiet-track/")
    return {"id":"recording_demo_123","provider":provider,"sourcePageUrl":page,
            "title":"Quiet track","composer":"Fixture Composer","performer":"Fixture Performer",
            "licenseCode":"CC-BY","licenseUrl":"https://creativecommons.org/licenses/by/4.0/",
            "attributionText":"Fixture Track by Fixture Performer, CC BY 4.0",
            "rightsEvidence":{part:{"basis":"Recorded assertion from the individual performer or rights holder for the recording.",
                                     "evidenceUrls":[page]} for part in lib.LAYERS},
            "providerAccessGrant":{"grantingParty":"Fixture Provider","scope":"Commercial redistribution and download permission",
                                   "evidenceUrl":"https://example.org/grants/recording-1"},
            "compositionRightsConfirmed":True,"masterRedistributionConfirmed":True,"territories":["US"],
            "unresolved":[],"sha1":hashlib.sha1(AUDIO).hexdigest(),"sha256":hashlib.sha256(AUDIO).hexdigest(),
            "bytes":len(AUDIO),"file":"quiet.mp3","mime":"audio/mpeg","period":"contemporary",
            "moods":["peaceful"],"instruments":["piano"],"energy":.25,"hasVocals":False}

def quality(peak=-1):
    r=item()
    return {"decodedFully":True,"sourceSha1":r["sha1"],"sha256":r["sha256"],"bytes":r["bytes"],
            "integratedLufs":-20,"truePeakDbfs":peak,"silenceRatio":.05,
            "clippedSampleRatio":0,"durationSeconds":130,"channels":2,"sampleRate":48000}

class ProviderIntakeTest(unittest.TestCase):
    def test_individual_sources_staged_never_publish(self):
        with tempfile.TemporaryDirectory() as td:
            d=pathlib.Path(td);(d/"quiet.mp3").write_bytes(AUDIO)
            for provider in ("fma","musopen"):
                with self.subTest(provider=provider), patch.object(lib,"measure",return_value=quality()):
                    result=lib.evaluate({"schemaVersion":1,"recordings":[item(provider)]},d)
                    self.assertEqual(result["summary"]["staged"],1)
                    self.assertFalse(result["publishable"])
                    self.assertEqual(result["results"][0]["status"],"qa_verified_staged")
    def test_restricted_source_and_rights_refused(self):
        edits=({"providerAccessGrant":{}},{"licenseCode":"CC-BY-NC"},
               {"sourcePageUrl":"http://localhost/track"},{"masterRedistributionConfirmed":False},
               {"unresolved":["master ownership contested"]},{"file":"../secret.mp3"},
               {"sha1":"not-a-sha"},{"territories":["*"]},{"rightsEvidence":{}},
               {"moods":[]})
        for edit in edits:
            with self.subTest(edit=edit):
                r=item();r.update(edit)
                with self.assertRaises(ValueError):lib.validate(r)
    def test_musopen_pd_is_source_specific_not_blanket_approval(self):
        candidate=item("musopen")
        candidate["licenseCode"]="PD"
        candidate["licenseUrl"]="https://musopen.org/faq/"
        self.assertEqual(lib.validate(candidate)["licenseCode"],"PD")
        candidate["provider"]="fma"
        with self.assertRaises(ValueError):lib.validate(candidate)
        candidate=item("musopen")
        candidate["providerAccessGrant"]["scope"]="Personal download and noncommercial listening only"
        with self.assertRaises(ValueError):lib.validate(candidate)
    def test_hash_mismatch_and_clip_prevent_qa_release(self):
        with tempfile.TemporaryDirectory() as td:
            d=pathlib.Path(td);(d/"quiet.mp3").write_bytes(b"wrong data")
            with patch.object(lib,"measure") as mock:
                result=lib.evaluate({"schemaVersion":1,"recordings":[item()]},d)
                mock.assert_not_called()
                self.assertEqual(result["summary"]["rejected"],1)
            (d/"quiet.mp3").write_bytes(AUDIO)
            with patch.object(lib,"measure",return_value=quality(peak=2)):
                result=lib.evaluate({"schemaVersion":1,"recordings":[item()]},d)
                self.assertEqual(result["summary"]["rejected"],1)
    def test_rights_only_must_not_claim_qa(self):
        with tempfile.TemporaryDirectory() as td:
            d=pathlib.Path(td);(d/"quiet.mp3").write_bytes(AUDIO)
            result=lib.evaluate({"schemaVersion":1,"recordings":[item()]},d,run_qa=False)
            self.assertEqual(result["results"][0]["status"],"rights_evidence_staged")
            self.assertNotIn("quality",result["results"][0])
    def test_duplicate_entries_and_queue_limit(self):
        with tempfile.TemporaryDirectory() as td:
            d=pathlib.Path(td);(d/"quiet.mp3").write_bytes(AUDIO)
            result=lib.evaluate({"schemaVersion":1,"recordings":[item(),item()]},d,run_qa=False)
            self.assertEqual(result["summary"]["rejected"],1)
            with self.assertRaises(ValueError):
                lib.evaluate({"schemaVersion":1,"recordings":[item(),item()]},d,limit=1)
    def test_symlink_prevents_escape(self):
        with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as outside:
            d=pathlib.Path(td);f=pathlib.Path(outside)/"recording.mp3";f.write_bytes(AUDIO)
            (d/"quiet.mp3").symlink_to(f)
            result=lib.evaluate({"schemaVersion":1,"recordings":[item()]},d,run_qa=False)
            self.assertEqual(result["summary"]["rejected"],1)

if __name__ == "__main__":
    unittest.main()

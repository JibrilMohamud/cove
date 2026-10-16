#!/usr/bin/env python3
"""Offline HTTP fixture tests for the production music readiness probe."""
import importlib.util
import io
import json
import pathlib
import unittest

spec=importlib.util.spec_from_file_location(
    "playback_health", pathlib.Path(__file__).with_name("verify-production-playback.py"))
probe=importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

class Reply(io.BytesIO):
    def __init__(self, data, status, headers=None):
        super().__init__(data)
        self.status=status
        self.headers=headers or {}

class Opener:
    def __init__(self, invalid=False, count=1):
        self.invalid=invalid
        self.count=count
        self.calls=[]
    def open(self, req, timeout=0):
        self.calls.append((req.full_url,req.get_method(),req.get_header("Range")))
        if req.full_url==probe.BASE+probe.PATH:
            files=[{"id":"cm_"+str(i),"audioUrl":probe.PATH+"/cm_"+str(i)+"/audio",
                    "attribution":"Fixture artist, CC BY 4.0",
                    "licenseUrl":"https://creativecommons.org/licenses/by/4.0/"} for i in range(self.count)]
            if self.invalid: files[0]["audioUrl"]="https://attacker.example/audio"
            return Reply(json.dumps({"count":self.count,"recordings":files}).encode(),200)
        if req.get_method()=="HEAD":
            return Reply(b"",200,{"Content-Length":"12345"})
        if req.get_method()=="GET":
            return Reply(b"AB",206,{"Content-Range":"bytes 0-1/"+("12346" if self.invalid else "12345")})
        raise AssertionError("Unexpected route")

class ProductionProbeTest(unittest.TestCase):
    def test_valid_audio_requires_real_head_and_range(self):
        fake=Opener()
        result=probe.run(limit=1,opener=fake)
        self.assertEqual(result["catalogCount"],1)
        self.assertEqual(result["sampled"],1)
        self.assertFalse(result["targetReached"])
        self.assertEqual(result["sampleFailed"],[])
        self.assertEqual(fake.calls[-1][2],"bytes=0-1")
    def test_rejects_untrusted_cdn_url(self):
        with self.assertRaisesRegex(ValueError,"Untrusted"):
            probe.run(limit=1,opener=Opener(invalid=True))
    def test_six_audit_slots_cover_every_one_of_300_originals(self):
        seen=set()
        for slot in range(6):
            report=probe.run(limit=50,opener=Opener(count=300),audit_slot=slot)
            self.assertEqual(report["sampled"],50)
            self.assertEqual(report["sampleFailed"],[])
            self.assertTrue(seen.isdisjoint(report["sampleIds"]))
            seen.update(report["sampleIds"])
        self.assertEqual(len(seen),300)
    def test_small_catalog_gets_complete_playback_audit(self):
        report=probe.run(limit=50,opener=Opener(count=35),audit_slot=4)
        self.assertEqual(report["sampled"],35)
        self.assertEqual(len(set(report["sampleIds"])),35)
    def test_invalid_slot_rejected(self):
        with self.assertRaises(ValueError):
            probe.run(limit=20,opener=Opener(count=3),audit_slot=-1)
    def test_monitor_has_pinned_origin(self):
        with self.assertRaises(ValueError):
            probe.run(base="https://evil.example",opener=Opener())

if __name__=="__main__":
    unittest.main()

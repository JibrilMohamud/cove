"""No-network independent Commons audio QA tests; no rights or customer access."""
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("open_qa", HERE / "qualify-isolated-commons.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ROOT = HERE.parent.parent
AUDIO = b"synthetic-not-valid-audio" * 20
SHA1 = hashlib.sha1(AUDIO).hexdigest()
SHA = hashlib.sha256(AUDIO).hexdigest()
SOURCE = "https://upload.wikimedia.org/wikipedia/commons/a/aa/Original.ogg"
ROW = {
    "id": "cm_123", "source_title": "File:Original.ogg",
    "source_file_url": SOURCE, "source_sha1": SHA1, "size_bytes": len(AUDIO),
    "license_code": "CC-BY", "license_url": "https://creativecommons.org/licenses/by/4.0/",
    "evidence_sha256": "a"*64,
}
CANDIDATE = {
    "id": ROW["id"], "sourceTitle": ROW["source_title"],
    "sourceFileUrl": SOURCE, "sourceSha1": SHA1, "sizeBytes": len(AUDIO),
    "licenseCode": ROW["license_code"], "licenseUrl": ROW["license_url"],
    "evidenceSha256": "b"*64,
    "evidence": {"commonsRevision": 3},
}
METRIC = {
    "sourceSha1": SHA1, "sha256": SHA, "bytes": len(AUDIO), "decodedFully": True,
    "durationSeconds": 120, "integratedLufs": -22,
    "truePeakDbfs": -1, "silenceRatio": .01, "clippedSampleRatio": 0,
}
class Response:
    def __init__(self, raw, declared=None):
        self.raw = io.BytesIO(raw)
        self.status = 200
        self.headers = {"Content-Length": str(len(raw) if declared is None else declared)}
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def read(self, n=-1):
        return self.raw.read(n)

class Opener:
    def __init__(self, raw=AUDIO, declared=None):
        self.raw = raw
        self.declared = declared
    def open(self, request, timeout=None):
        return Response(self.raw, self.declared)

class PrivateR2:
    def __init__(self, corrupt=False):
        self.objects = {}
        self.corrupt = corrupt
    def put_object(self, Bucket, Key, Body, Metadata):
        assert Bucket == module.BUCKET
        self.objects[Key] = Body.read()
        return {}
    def get_object(self, Bucket, Key):
        raw = self.objects[Key]
        return {"Body": io.BytesIO((b"x"+raw[1:]) if self.corrupt else raw)}

class Tests(unittest.TestCase):
    def test_authoritative_recheck_requires_exact_source_identity_and_cc_terms(self):
        with patch.object(module.DISCOVERY, "verified_commons_title", return_value={"title": "ignored"}), \
             patch.object(module.DISCOVERY, "exact_candidate", return_value=CANDIDATE):
            self.assertEqual(module.authoritative(ROW)["sourceSha1"], SHA1)
            for key,value in [
                ("source_sha1", "f"*40), ("size_bytes", len(AUDIO)+1),
                ("license_code", "CC0"), ("source_file_url", SOURCE + "?tracking=1")]:
                with self.assertRaisesRegex(ValueError, "original_or_license_changed"):
                    module.authoritative({**ROW,key:value})
    def test_no_redirect_unbounded_or_mismatched_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / "original.ogg"
            self.assertEqual(module.download_original(CANDIDATE,path,Opener()), {
                "sha256": SHA, "bytes": len(AUDIO)})
            with self.assertRaisesRegex(ValueError, "content_length_changed"):
                module.download_original(CANDIDATE,path,Opener(declared=len(AUDIO)+1))
            with self.assertRaisesRegex(ValueError, "sha1_or_size_mismatch"):
                module.download_original(CANDIDATE,path,Opener(raw=b"y"*len(AUDIO)))
            with self.assertRaisesRegex(ValueError, "untrusted_original_url"):
                module.download_original({**CANDIDATE,"sourceFileUrl":
                                          "https://evil.example/a.ogg"},path,Opener())
    def test_private_r2_requires_exact_readback_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp)/"a.ogg"
            path.write_bytes(AUDIO)
            r2 = PrivateR2()
            module.r2_put_verified(r2,"music-open-qa/originals/"+SHA+".ogg",path,SHA,len(AUDIO))
            self.assertEqual(len(r2.objects),1)
            with self.assertRaisesRegex(RuntimeError,"private_r2_integrity_failed"):
                module.r2_put_verified(PrivateR2(corrupt=True),"key",path,SHA,len(AUDIO))
    def test_sql_receipts_are_detached_and_permanently_unapproved(self):
        sqlite = sqlite3.connect(":memory:")
        sqlite.row_factory = sqlite3.Row
        try:
            sqlite.executescript(
                (ROOT/"infra/music/0004_open_catalog_candidates.sql").read_text()+
                (ROOT/"infra/music/0006_open_technical_qa.sql").read_text())
            sqlite.execute(
                "INSERT INTO music_open_source_candidates"
                "(id,discovery_provider,source_page_url,source_file_url,source_title,"
                "source_sha1,size_bytes,license_code,license_url,evidence_json,"
                "evidence_sha256,discovered_at,last_seen_at)"
                " VALUES(?,'commons','https://commons.wikimedia.org/wiki/File:Original.ogg',"
                "?,?,?,?,?,?,'{}',?,'2026-10-24','2026-10-24')",
                (ROW["id"],SOURCE,ROW["source_title"],SHA1,len(AUDIO),
                 ROW["license_code"],ROW["license_url"],ROW["evidence_sha256"]))
            def fake_d1(sql,params,token):
                statement = sqlite.execute(sql,params)
                return [dict(x) for x in statement.fetchall()] if sql.startswith("SELECT") else []
            with patch.object(module,"d1",side_effect=fake_d1):
                module.persist_measured("token",ROW,{"sha256":SHA,"bytes":len(AUDIO)},
                    METRIC,None,"music-open-qa/originals/"+SHA+".ogg",
                    "music-open-qa/reports/"+SHA+"/"+"c"*64+".json","c"*64,CANDIDATE)
            receipt = dict(sqlite.execute("SELECT status,rights_status,quiet_status,"
                                          "source_sha256 FROM music_open_technical_qa").fetchone())
            self.assertEqual(receipt,{
                "status":"measured","rights_status":"unreviewed",
                "quiet_status":"unreviewed","source_sha256":SHA})
            with self.assertRaises(sqlite3.IntegrityError):
                sqlite.execute("UPDATE music_open_technical_qa SET rights_status='approved'")
            self.assertEqual(sqlite.execute(
                "SELECT COUNT(*) FROM music_open_technical_qa").fetchone()[0],1)
        finally:
            sqlite.close()
    def test_disabled_and_dry_run_never_upload_or_write(self):
        def prep(row,temp,**kwargs):
            path = pathlib.Path(temp)/"original.ogg"
            path.write_bytes(AUDIO)
            return CANDIDATE,{"sha256":SHA,"bytes":len(AUDIO)},METRIC,None,path
        with patch.object(module,"claim_read",return_value=[ROW]), \
             patch.object(module,"prepare_one",side_effect=prep), \
             patch.object(module,"persist_measured") as store:
            summary = module.run(1,False,False,"token")
            self.assertEqual(summary["results"][0]["status"],"verified_dry_run")
            self.assertFalse(summary["customerPublished"])
            store.assert_not_called()
            with patch.dict(os.environ,{"COVE_MUSIC_OPEN_QA_APPLY":"0"}):
                with self.assertRaisesRegex(ValueError,"disabled"):
                    module.run(1,True,False,"token",PrivateR2())
            with patch.dict(os.environ,{"COVE_MUSIC_OPEN_QA_APPLY":"1"}):
                summary = module.run(1,True,False,"token",PrivateR2())
                self.assertEqual(summary["results"][0]["status"],"stored_private_technical_qa")
                store.assert_called_once()
    def test_unsafe_caps_are_rejected(self):
        for n in (0,3,100):
            with self.assertRaises(ValueError):
                module.claim_read("token",n)
        for bad in ("../x","cm_1' OR 1=1","cm_foo"):
            with self.assertRaises(ValueError):
                module.claim_read("token",1,bad)

if __name__ == "__main__":
    unittest.main()

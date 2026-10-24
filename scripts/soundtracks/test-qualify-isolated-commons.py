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
    def close(self):
        self.raw.close()

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
    def test_private_terminal_rights_hold_is_successful_no_playback_and_transients_retry(self):
        with patch.dict(os.environ,{"COVE_MUSIC_OPEN_QA_APPLY":"1"}), \
             patch.object(module,"claim_read",return_value=[ROW]), \
             patch.object(module,"persist_durable_hold") as held:
            with patch.object(module,"prepare_one",
                              side_effect=ValueError("original_or_license_changed")):
                output=module.run(1,True,False,"token",PrivateR2())
                self.assertEqual(output["results"][0]["status"],"stored_private_technical_hold")
                self.assertFalse(output["rightsApproved"])
                held.assert_called_once_with("token",ROW,"original_or_license_changed")
            held.reset_mock()
            with patch.object(module,"prepare_one",
                              side_effect=ValueError("Temporary Commons API error")):
                output=module.run(1,True,False,"token",PrivateR2())
                self.assertEqual(output["results"][0]["status"],"retryable_source_error")
                held.assert_not_called()
                self.assertFalse(output["customerPublished"])

    def test_full_decode_quality_thresholds_never_imply_quiet_approval(self):
        self.assertTrue(module.validate_full_audio_quality(METRIC))
        for key,value in [
            ("durationSeconds", 19), ("integratedLufs", -50),
            ("truePeakDbfs", 1), ("silenceRatio", .25),
            ("clippedSampleRatio", .001), ("integratedLufs", float("nan"))]:
            with self.assertRaisesRegex(ValueError, "full_audio_quality_not_eligible"):
                module.validate_full_audio_quality({**METRIC,key:value})
        with self.assertRaisesRegex(ValueError, "full_audio_decode_incomplete"):
            module.validate_full_audio_quality({**METRIC,"decodedFully":False})

    def test_permanent_hold_cannot_upgrade_rights(self):
        calls=[]
        def fake(sql, params, token):
            calls.append(sql)
            if sql.startswith("SELECT"):
                return [{"status":"held","hold_reason":"full_audio_quality_not_eligible"}]
            return []
        with patch.object(module,"d1",side_effect=fake):
            module.persist_durable_hold("token",ROW,"full_audio_quality_not_eligible")
        self.assertIn("'held'",calls[0])
        self.assertNotIn("rights_status",calls[0])
        self.assertNotIn("quiet_status",calls[0])

    def test_scoped_rest_bucket_put_and_full_readback_without_s3_secrets(self):
        class RestOpener:
            def __init__(self):
                self.contents = {}
                self.urls = []
            def open(self, request, timeout=None):
                url = request.full_url
                self.urls.append(url)
                self.assertable_url = url
                if request.get_method() == "PUT":
                    assert request.get_header("Authorization") == "Bearer test-token"
                    assert request.get_header("Content-type") == "application/octet-stream"
                    self.contents[url] = request.data
                    return Response(b"")
                if request.get_method() == "GET":
                    assert request.get_header("Authorization") == "Bearer test-token"
                    return Response(self.contents[url])
                raise AssertionError("Unexpected private R2 operation")
        with tempfile.TemporaryDirectory() as temp:
            original = pathlib.Path(temp)/"audio.ogg"
            original.write_bytes(AUDIO)
            transport = RestOpener()
            with patch.dict(os.environ, {
                "CLOUDFLARE_ACCOUNT_ID":module.ACCOUNT,
                "COVE_MUSIC_R2_BACKEND":"cloudflare_api",
                "CLOUDFLARE_API_TOKEN":"test-token"
            }):
                remote = module.make_r2()
                assert remote.__class__ == module.PrivateCloudflareR2
                remote.opener = transport
                module.r2_put_verified(remote, "music-open-qa/originals/"+SHA+".ogg",
                    original, SHA, len(AUDIO))
            self.assertEqual(len(transport.urls),2)
            self.assertIn(module.BUCKET,transport.urls[0])
            self.assertTrue(all(u.startswith("https://api.cloudflare.com/") for u in transport.urls))
            for key in ("music-open-qa/../../bypass", "music-open-qa/originals/"+SHA+".wav",
                        "music-open-qa/reports/"+SHA+"/foo.json",
                        "published/"+SHA+".ogg"):
                with self.assertRaisesRegex(ValueError,"untrusted_private_r2_object_key"):
                    module.PrivateCloudflareR2.object_url(module.BUCKET,key)
            with self.assertRaisesRegex(ValueError,"untrusted_private_r2_object_key"):
                module.PrivateCloudflareR2.object_url("not-private-bucket",
                    "music-open-qa/originals/"+SHA+".ogg")

    def test_scheduled_source_cohorts_rotate_and_skip_already_measured(self):
        db=sqlite3.connect(":memory:")
        db.row_factory=sqlite3.Row
        try:
            db.executescript((ROOT/"infra/music/0004_open_catalog_candidates.sql").read_text())
            db.executescript((ROOT/"infra/music/0006_open_technical_qa.sql").read_text())
            for num in (1,20,42,63):
                db.execute(
                    "INSERT INTO music_open_source_candidates"
                    "(id,discovery_provider,source_page_url,source_file_url,source_title,"
                    "source_sha1,size_bytes,license_code,license_url,evidence_json,"
                    "evidence_sha256,discovered_at,last_seen_at)"
                    " VALUES(?,'commons','https://commons.wikimedia.org/wiki/File:Sample.ogg',"
                    " 'https://upload.wikimedia.org/wikipedia/commons/a/aa/Sample.ogg',"
                    " 'File:Sample.ogg',?,1000,'CC-BY',"
                    " 'https://creativecommons.org/licenses/by/4.0/','{}',?,"
                    " '2026-10-24','2026-10-24')",
                    ("cm_"+str(num),SHA1,"a"*64))
            def read(sql,values,token):
                return [dict(row) for row in db.execute(sql,values)]
            with patch.object(module,"d1",side_effect=read):
                early=[x["id"] for x in module.claim_read("token",2,rotation=0)]
                later=[x["id"] for x in module.claim_read("token",2,rotation=42)]
                self.assertEqual(early,["cm_1","cm_20"])
                self.assertEqual(later,["cm_42","cm_63"])
                db.execute(
                    "INSERT INTO music_open_technical_qa"
                    "(candidate_id,source_sha1,source_evidence_sha256,status,hold_reason,measured_at)"
                    " VALUES('cm_42',? ,?,'held','source_drift','2026-10-24')",
                    (SHA1,"a"*64))
                rotated=[x["id"] for x in module.claim_read("token",2,rotation=42)]
                self.assertEqual(rotated,["cm_63","cm_1"],
                                 "Durable technical holds never consume future QA capacity")
        finally:
            db.close()

    def test_unsafe_caps_are_rejected(self):
        for n in (0,3,100):
            with self.assertRaises(ValueError):
                module.claim_read("token",n)
        for bad_rotation in (-1,64,"0",True):
            with self.assertRaises(ValueError):
                module.claim_read("token",1,rotation=bad_rotation)
        for bad in ("../x","cm_1' OR 1=1","cm_foo"):
            with self.assertRaises(ValueError):
                module.claim_read("token",1,bad)

if __name__ == "__main__":
    unittest.main()

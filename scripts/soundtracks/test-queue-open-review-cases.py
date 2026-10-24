"""No-network detached rights/quietness review queue regression tests."""
import importlib.util
import json
import os
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("music_review",HERE/"queue-open-review-cases.py")
review=importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)
ROOT=HERE.parent.parent
A="a"*64
B="b"*64
C="c"*64
S="d"*40

def seeded_db():
    db=sqlite3.connect(":memory:")
    db.row_factory=sqlite3.Row
    for filename in ("0004_open_catalog_candidates.sql","0006_open_technical_qa.sql",
                     "0007_open_review_cases.sql"):
        db.executescript((ROOT/"infra/music"/filename).read_text())
    ev=json.dumps({"rawArtist":"Original performer","rawCredit":"Archived original",
                   "commonsRevision":123})
    db.execute("INSERT INTO music_open_source_candidates"
               "(id,discovery_provider,source_page_url,source_file_url,source_title,"
               "source_sha1,size_bytes,license_code,license_url,evidence_json,"
               "evidence_sha256,discovered_at,last_seen_at)"
               "VALUES('cm_123','commons','https://commons.wikimedia.org/wiki/File:Example.ogg',"
               "'https://upload.wikimedia.org/wikipedia/commons/a/ab/Example.ogg',"
               "'File:Example.ogg',?,1000,'CC-BY-SA',"
               "'https://creativecommons.org/licenses/by-sa/2.0/',?,?,"
               "'2026-10-24','2026-10-24')",(S,ev,C))
    db.execute("INSERT INTO music_open_technical_qa"
               "(candidate_id,source_sha1,source_sha256,original_bytes,"
               "source_evidence_sha256,audio_r2_key,report_r2_key,report_sha256,"
               "status,measured_at)"
               "VALUES('cm_123',?,?,1000,?,"
               "'music-open-qa/originals/source.ogg',"
               "'music-open-qa/reports/report.json',?,'measured','2026-10-24')",
               (S,A,C,B))
    return db

def d1(db):
    def query(sql,params,token):
        cur=db.execute(sql,params)
        return [dict(row) for row in cur.fetchall()] if sql.startswith("SELECT") else []
    return query

class Tests(unittest.TestCase):
    def test_dry_run_and_disabled_are_permanently_nonpublishing(self):
        db=seeded_db()
        try:
            out=review.run("token",query=d1(db))
            self.assertEqual(out["casesCreated"],0)
            self.assertFalse(out["customerPublished"])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM music_open_review_cases").fetchone()[0],0)
            with patch.dict(os.environ,{"COVE_MUSIC_REVIEW_APPLY":"0"}):
                with self.assertRaisesRegex(ValueError,"admission_disabled"):
                    review.run("token",apply=True,query=d1(db))
        finally:
            db.close()

    def test_immutable_two_case_review_cohort_never_grants_rights(self):
        db=seeded_db()
        try:
            with patch.dict(os.environ,{"COVE_MUSIC_REVIEW_APPLY":"1"}):
                out=review.run("token",apply=True,query=d1(db))
            self.assertEqual(out["casesCreated"],2)
            self.assertFalse(out["rightsApproved"])
            self.assertFalse(out["quietApproved"])
            rows=[dict(x) for x in db.execute(
                "SELECT review_kind,status,reason,attribution_draft,evidence_json"
                " FROM music_open_review_cases ORDER BY review_kind")]
            self.assertEqual([x["status"] for x in rows],["needs_review"]*2)
            self.assertEqual(set(x["review_kind"] for x in rows),
                             {"rights_provenance","quiet_suitability"})
            self.assertTrue(all("Original performer" in x["attribution_draft"] for x in rows))
            self.assertTrue(all(json.loads(x["evidence_json"])["customerPlayable"] is False
                                for x in rows))
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE music_open_review_cases SET status='approved'")
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE music_open_technical_qa SET rights_status='approved'")
            with patch.dict(os.environ,{"COVE_MUSIC_REVIEW_APPLY":"1"}):
                self.assertEqual(review.run("token",apply=True,query=d1(db))["casesCreated"],0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM music_masters").fetchone()[0],0) if                 db.execute("SELECT name FROM sqlite_master WHERE name='music_masters'").fetchone() else None
        finally:
            db.close()

    def test_source_evidence_drift_does_not_create_review_cases(self):
        db=seeded_db()
        try:
            db.execute("UPDATE music_open_source_candidates SET evidence_sha256=?",("e"*64,))
            with patch.dict(os.environ,{"COVE_MUSIC_REVIEW_APPLY":"1"}):
                self.assertEqual(review.run("token",apply=True,query=d1(db))["casesCreated"],0)
        finally:
            db.close()

    def test_invalid_limit_or_report_hash_fails_closed(self):
        for limit in (0,3,True,100):
            with self.assertRaisesRegex(ValueError,"review_batch_out_of_range"):
                review.select_pending("token",limit,lambda *_:[])
        db=seeded_db()
        try:
            source=review.select_pending("token",1,d1(db))[0]
            for key,value in [("source_sha256","bad"),("report_sha256","bad"),
                              ("source_evidence_sha256","f"*64)]:
                with self.assertRaisesRegex(ValueError,"review_evidence_not_stable"):
                    review.make_cases({**source,key:value})
        finally:
            db.close()

if __name__=="__main__":
    unittest.main()

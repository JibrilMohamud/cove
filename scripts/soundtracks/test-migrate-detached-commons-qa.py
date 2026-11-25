#!/usr/bin/env python3
import hashlib
import importlib.util
import pathlib
import sqlite3
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("commons_migration", HERE / "migrate-detached-commons-qa.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)

class Database:
    def __init__(self, populated=False, read_only=False):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.read_only = read_only
        if populated:
            for path in sorted(M.MIGRATIONS.glob("*.sql")):
                self.conn.executescript(path.read_text())
    def query(self, sql, params=()):
        if self.read_only and not sql.startswith("SELECT"):
            raise AssertionError("attempted source write")
        cur = self.conn.execute(sql, params)
        rows = [dict(r) for r in cur.fetchall()]
        self.conn.commit()
        return rows
    def batch(self, statements):
        if self.read_only:
            raise AssertionError("attempted source batch")
        with self.conn:
            for sql, params in statements:
                self.conn.execute(sql, params)
    def close(self):
        self.conn.close()

class Tests(unittest.TestCase):
    def setUp(self):
        self.source = Database(True)
        self.target = Database()
        self.audio = b"a" * 128
        self.report = b'{"qa":true}'
        self.audio_sha = hashlib.sha256(self.audio).hexdigest()
        self.report_sha = hashlib.sha256(self.report).hexdigest()
        self.audio_key = "music-open-qa/originals/" + self.audio_sha + ".ogg"
        self.report_key = "music-open-qa/reports/" + self.audio_sha + "/" + self.report_sha + ".json"
        self.source.query("INSERT INTO music_open_source_candidates "
                          "(id,discovery_provider,source_page_url,source_file_url,source_title,source_sha1,"
                          "size_bytes,license_code,license_url,evidence_json,evidence_sha256,discovered_at,last_seen_at)"
                          " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          ("cm_1","commons","https://commons.wikimedia.org/wiki/File:Original.ogg",
                           "https://upload.wikimedia.org/original.ogg","File:Original.ogg","a"*40,128,
                           "CC0","https://creativecommons.org/publicdomain/zero/1.0/","{}","b"*64,"now","now"))
        self.source.query("INSERT INTO music_open_technical_qa "
                          "(candidate_id,source_sha1,source_sha256,original_bytes,source_evidence_sha256,"
                          "audio_r2_key,report_r2_key,report_sha256,status,measured_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                          ("cm_1","a"*40,self.audio_sha,128,"b"*64,self.audio_key,self.report_key,
                           self.report_sha,"measured","now"))
        self.source.query("INSERT INTO music_open_review_cases "
                          "(candidate_id,review_kind,source_sha1,original_sha256,technical_report_sha256,"
                          "discovery_evidence_sha256,reason,attribution_draft,evidence_json,recorded_at)"
                          " VALUES(?,?,?,?,?,?,?,?,?,?)",
                          ("cm_1","rights_provenance","a"*40,self.audio_sha,self.report_sha,"b"*64,
                           "recording_license_upstream_reconciliation","draft","{}","now"))
        self.source.read_only = True
        self.copied = {}
        self.quiescent_checks = 0
    def tearDown(self):
        self.source.close()
        self.target.close()
    def transfer(self, key, value):
        data = {self.audio_key:self.audio, self.report_key:self.report}[key]
        M.verify_bytes(data, *value)
        self.copied[key] = value
        return len(data)
    def quiescent(self):
        self.quiescent_checks += 1
    def run_copy(self):
        return M.migrate(self.source,self.target,self.transfer,self.quiescent)
    def test_full_copy_and_idempotence(self):
        result = self.run_copy()
        self.assertEqual(result["objectCount"],2)
        self.assertEqual(result["sourceCounts"]["music_open_review_cases"],1)
        self.assertEqual(self.quiescent_checks,2)
        self.assertFalse(result["sourceMutation"])
        self.assertEqual(self.target.query("SELECT rights_status,quiet_status FROM music_open_technical_qa"),
                         [{"rights_status":"unreviewed","quiet_status":"unreviewed"}])
        self.target.query("UPDATE music_open_source_candidates SET last_seen_at='new'")
        self.copied.clear()
        result = self.run_copy()
        self.assertTrue(result["alreadyVerified"])
        self.assertEqual(self.target.query("SELECT last_seen_at FROM music_open_source_candidates"), [{"last_seen_at":"new"}])
        self.assertEqual(self.copied,{})
    def test_hash_failure_prevents_marker_and_resumes(self):
        with self.assertRaisesRegex(RuntimeError,"commons_object_hash_mismatch"):
            M.migrate(self.source,self.target,lambda key,value:M.verify_bytes(b"wrong",*value),self.quiescent)
        self.assertEqual(self.target.query("SELECT id FROM "+M.RECEIPT),[])
        self.assertEqual(self.run_copy()["objectCount"],2)
    def test_interrupted_copy_rejects_changed_destination_without_deleting(self):
        with self.assertRaisesRegex(RuntimeError,"commons_object_hash_mismatch"):
            M.migrate(self.source,self.target,lambda key,value:M.verify_bytes(b"wrong",*value),self.quiescent)
        self.target.query("UPDATE music_open_source_candidates SET last_seen_at='drift'")
        with self.assertRaisesRegex(RuntimeError,"commons_partial_destination_drift"):
            self.run_copy()
        self.assertEqual(self.target.query("SELECT id FROM "+M.RECEIPT),[])
        self.assertEqual(self.target.query("SELECT last_seen_at FROM music_open_source_candidates"),
                         [{"last_seen_at":"drift"}])
        self.assertEqual(len(self.target.query("SELECT candidate_id FROM music_open_review_cases")),1)
    def test_non_quiescent_and_wrong_database_fail_closed(self):
        def running():
            raise RuntimeError("commons_legacy_writer_still_running")
        with self.assertRaisesRegex(RuntimeError,"legacy_writer"):
            M.migrate(self.source,self.target,self.transfer,running)
        self.target.query("CREATE TABLE rights_grants(id TEXT)")
        with self.assertRaisesRegex(RuntimeError,"not_dedicated"):
            self.run_copy()
    def test_orphan_exception_exact_identity_and_provider_required(self):
        run = {"id": M.ORPHAN_ID, "head_sha": M.ORPHAN_SHA, "head_branch": "main",
               "event": "schedule", "path": ".github/workflows/" + M.ORPHAN_WORKFLOW,
               "status": "queued"}
        self.assertTrue(M.exact_orphan(run, M.ORPHAN_WORKFLOW, "queued"))
        for k, v in (("id", 1), ("head_sha", "a"*40), ("head_branch", "other"),
                     ("event", "push"), ("path", "other.yml"), ("status", "in_progress")):
            self.assertFalse(M.exact_orphan({**run,k:v}, M.ORPHAN_WORKFLOW, "queued"))
        self.assertFalse(M.exact_orphan(run, M.ORPHAN_WORKFLOW, "in_progress"))
        self.assertFalse(M.exact_orphan(run, "other.yml", "queued"))
        import json
        from types import SimpleNamespace
        responses = [json.dumps(run).encode(), b'{"total_count":0,"jobs":[]}']
        with patch.object(M,"request",side_effect=responses), patch.object(
                M.subprocess,"run",return_value=SimpleNamespace(returncode=1,stdout="")):
            with self.assertRaisesRegex(RuntimeError,"provider_write_fence_unverified"):
                M.prove_orphan_fenced("github")
        with patch.object(M,"request",side_effect=responses), patch.object(
                M.subprocess,"run",return_value=SimpleNamespace(
                    returncode=0,stdout="COMMONS_ARCHIVED_SOURCE_FENCED\n")):
            M.prove_orphan_fenced("github")
        with patch.object(M,"request",side_effect=[responses[0],b'{"total_count":1,"jobs":[{}]}']):
            with self.assertRaisesRegex(RuntimeError,"jobs_present"):
                M.prove_orphan_fenced("github")

    def test_source_mutation_and_untrusted_keys_refused(self):
        source = M.D1(M.SOURCE_ACCOUNT,M.SOURCE_DB,"read",True)
        with self.assertRaisesRegex(RuntimeError,"source_write"):
            source.query("DELETE FROM music_open_source_candidates")
        with self.assertRaisesRegex(RuntimeError,"object_key"):
            M.object_url(M.QA_ACCOUNT,M.QA_BUCKET,"../other")
        with self.assertRaisesRegex(RuntimeError,"d1_target"):
            M.D1(M.SOURCE_ACCOUNT,M.SOURCE_DB,"write",False)
        with self.assertRaisesRegex(RuntimeError,"object_hash"):
            M.verify_bytes(b"bad",self.audio_sha,128)
    def test_source_drift_rejects_receipt(self):
        checks=0
        def drift():
            nonlocal checks
            checks+=1
            if checks==2:
                self.source.read_only=False
                self.source.query("UPDATE music_open_source_candidates SET last_seen_at='drift'")
                self.source.read_only=True
        with self.assertRaisesRegex(RuntimeError,"source_changed"):
            M.migrate(self.source,self.target,self.transfer,drift)
        self.assertEqual(self.target.query("SELECT id FROM "+M.RECEIPT),[])
    def test_provider_object_transfer(self):
        source_url=M.object_url(M.SOURCE_ACCOUNT,M.SOURCE_BUCKET,self.audio_key)
        dest_url=M.object_url(M.QA_ACCOUNT,M.QA_BUCKET,self.audio_key)
        calls=[]
        stored={}
        def fake(url,token,method="GET",data=None,limit=0,missing=False):
            calls.append((url,token,method))
            if url==source_url:
                self.assertEqual((token,method),("source","GET"))
                return self.audio
            self.assertEqual((url,token),(dest_url,"qa"))
            if method=="PUT":
                stored[url]=data
                return b""
            return stored.get(url)
        with patch.object(M,"request",fake):
            self.assertEqual(M.copy_object(self.audio_key,(self.audio_sha,128),"source","qa"),128)
        self.assertEqual([c[2] for c in calls],["GET","GET","PUT","GET"])
    def test_workflow_scope_and_no_legacy_secret(self):
        root=HERE.parents[1]
        for name in M.WORKFLOWS:
            text=(root/".github"/"workflows"/name).read_text()
            self.assertNotIn("secrets.CLOUDFLARE_API_TOKEN",text)
            self.assertIn("CLOUDFLARE_ACCOUNT_ID: "+M.QA_ACCOUNT,text)
            self.assertIn("group: cove-detached-commons-qa-account",text)
            self.assertIn("run: python scripts/soundtracks/migrate-detached-commons-qa.py",text)
            self.assertIn("environment: cove-production-release-audit",text)
        for name in ("discover-openverse-commons.py","qualify-isolated-commons.py",
                     "queue-open-review-cases.py","report-isolated-supply.py"):
            text=(HERE/name).read_text()
            self.assertNotIn(M.SOURCE_DB,text)
            self.assertNotIn(M.SOURCE_ACCOUNT,text)
            self.assertIn("COVE_COMMONS_QA_MIGRATION_VERIFIED",text)

if __name__=="__main__":
    unittest.main()

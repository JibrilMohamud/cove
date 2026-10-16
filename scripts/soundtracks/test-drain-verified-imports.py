#!/usr/bin/env python3
"""Isolated synthetic tests; no licensed music or network calls."""
import importlib.util
import io
import json
import pathlib
import unittest

src=pathlib.Path(__file__).with_name("drain-verified-imports.py")
spec=importlib.util.spec_from_file_location("cove_drain_imports",src)
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class Reply(io.BytesIO):
    def __init__(self,status,body=b"",headers=None):
        super().__init__(body)
        self.status=status
        self.headers=headers or {}

class Opener:
    def __init__(self, imports):
        self.imports=list(imports)
        self.calls=[]
    def open(self, req, timeout):
        self.calls.append((req.get_method(),req.full_url,req.get_header("Range"),req.get_header("Authorization"),req.get_header("Content-type"),req.data))
        if req.get_method()=="POST":
            payload=self.imports.pop(0)
            return Reply(200,json.dumps(payload).encode())
        if req.get_method()=="HEAD":
            return Reply(200,headers={"Content-Length":"1234","Content-Type":"audio/ogg"})
        return Reply(206,b"OG",{"Content-Range":"bytes 0-1/1234"})

class DrainTests(unittest.TestCase):
    def test_exact_identity_and_ranged_audio(self):
        o=Opener([{"stored":"cm_123"},{"skipped":"no_approved_recordings"}])
        result=mod.drain("fore_svc_fixture",attempts=5,opener=o)
        self.assertEqual(result["playableVerified"],1)
        self.assertEqual([r["status"] for r in result["results"]],["playable_verified","skipped"])
        self.assertEqual([c[0] for c in o.calls],["POST","HEAD","GET","POST"])
        self.assertEqual(o.calls[2][2],"bytes=0-1")
        self.assertTrue(all(c[1].startswith(mod.ORIGIN+"/api/fore/") for c in o.calls))
        self.assertTrue(o.calls[0][3].startswith("Bearer fore_svc_"))
        self.assertEqual(o.calls[0][4],"application/json","Cove rejects non-JSON mutations before auth routing")
        self.assertEqual(o.calls[0][5],b"{}")
        self.assertIsNone(o.calls[1][3],"Never leak admin token to public playback")
    def test_untrusted_worker_identity_is_not_counted(self):
        o=Opener([{"stored":"https://malicious.example/recording"}])
        result=mod.drain("fore_svc_fixture",attempts=1,opener=o)
        self.assertEqual(result["playableVerified"],0)
        self.assertEqual(result["results"][0]["status"],"verification_failed")
    def test_source_rights_drift_is_visible_hold(self):
        o=Opener([{"invalidated":"cm_123"},{"failed":"cm_456"},{"skipped":"leased"}])
        r=mod.drain("fore_svc_fixture",attempts=5,opener=o)
        self.assertEqual([x["status"] for x in r["results"]],["import_held","import_held","skipped"])
        self.assertEqual(r["playableVerified"],0)
    def test_mutation_error_does_not_retry(self):
        class Broken:
            attempts=0
            def open(self,*args,**kwargs):
                self.attempts+=1
                raise OSError("synthetic gateway failure")
        o=Broken()
        result=mod.drain("fore_svc_fixture",attempts=8,opener=o)
        self.assertEqual(o.attempts,1)
        self.assertEqual(result["results"][0]["status"],"request_failed")
    def test_scoped_token_and_budgets_enforced(self):
        with self.assertRaises(ValueError):
            mod.drain("unscoped")
        with self.assertRaises(ValueError):
            mod.drain("fore_svc_fixture",attempts=40)
        with self.assertRaises(ValueError):
            mod.drain("fore_svc_fixture",minutes=30)

if __name__=="__main__":
    unittest.main()

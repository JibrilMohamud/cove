#!/usr/bin/env python3
import hashlib
import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

path=pathlib.Path(__file__).with_name('submit-authorized-provider.py')
spec=importlib.util.spec_from_file_location('submit_authorized_provider',path)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
AUDIO=b'This is synthetic audio for upload tests only.'
SHA1=hashlib.sha1(AUDIO).hexdigest()
SHA256=hashlib.sha256(AUDIO).hexdigest()

def fixture():
    item={'id':'source_test_01','file':'example.mp3','provider':'fma',
      'sourcePageUrl':'https://freemusicarchive.org/music/Artist/Album/Example/',
      'sha1':SHA1,'sha256':SHA256,'bytes':len(AUDIO),'mime':'audio/mpeg',
      'licenseCode':'CC-BY','licenseUrl':'https://creativecommons.org/licenses/by/4.0/',
      'title':'Example','performer':'Example pianist'}
    return {'schemaVersion':1,'recordings':[item]}, {'schemaVersion':1,'publishable':False,'results':[{
      'id':'source_test_01','status':'qa_verified_staged','quality':{
        'sourceSha1':SHA1,'sha256':SHA256,'bytes':len(AUDIO)},
      'source':{k:item[k] for k in ('provider','sourcePageUrl','sha1','sha256','bytes')}}]}

class SubmissionTest(unittest.TestCase):
    def test_preview_never_networks(self):
        with tempfile.TemporaryDirectory() as d:
            pathlib.Path(d,'example.mp3').write_bytes(AUDIO)
            manifest,receipts=fixture()
            with patch.object(module,'request') as network:
                result=module.run(manifest,receipts,pathlib.Path(d),'https://example.invalid','',False)
                network.assert_not_called()
            self.assertEqual(result['summary']['accepted'],1)
            self.assertFalse(result['publishable'])
    def test_private_stage_never_approves(self):
        with tempfile.TemporaryDirectory() as d:
            pathlib.Path(d,'example.mp3').write_bytes(AUDIO)
            manifest,receipts=fixture()
            calls=[]
            def fake(origin,token,path,method,data,ct):
                calls.append((path,method))
                return {'id':'ex_demo','status':'pending_review'} if method=='POST' else {'status':'staged'}
            with patch.object(module,'request',side_effect=fake):
                result=module.run(manifest,receipts,pathlib.Path(d),'https://cove.example','fore_svc_demo',True)
            self.assertEqual(result['results'][0]['status'],'staged_private_r2')
            self.assertEqual([v[1] for v in calls],['POST','PUT'])
            self.assertTrue(all('/approve' not in v[0] for v in calls))
    def test_mismatched_receipts_and_files_fail_closed(self):
        with tempfile.TemporaryDirectory() as d:
            f=pathlib.Path(d,'example.mp3')
            f.write_bytes(b'incorrect')
            manifest,receipts=fixture()
            with patch.object(module,'request') as network:
                self.assertEqual(module.run(manifest,receipts,pathlib.Path(d),'https://cove.example','',True)['summary']['rejected'],1)
                network.assert_not_called()
            f.write_bytes(AUDIO)
            receipts['results'][0]['quality']['sha256']='e'*64
            self.assertEqual(module.run(manifest,receipts,pathlib.Path(d),'https://cove.example','',False)['summary']['rejected'],1)
    def test_exact_https_origin(self):
        for url in ('http://localhost','https://example.org/admin','https://user:pass@example.org','https://example.org:444'):
            with self.assertRaises(ValueError):
                module.secure_origin(url)
        self.assertEqual(module.secure_origin('https://cove.example'),'https://cove.example')

if __name__=='__main__':
    unittest.main()

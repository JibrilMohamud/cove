import importlib.util
import json
import pathlib
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location("cove_commons_seed",
    pathlib.Path(__file__).with_name("seed-commons-from-openverse.py"))
app=importlib.util.module_from_spec(spec);spec.loader.exec_module(app)

class Response:
    status=200
    def __enter__(self): return self
    def __exit__(self,*args): return None
    def read(self,n):
        return json.dumps(dict(queued=1,existing=0,held=0,
                               publicationAuthorized=False,customerAudioCopied=False)).encode()

class Client:
    def __init__(self):self.calls=[]
    def open(self,req,timeout):
        self.calls.append(req)
        return Response()

class TestTrustedSourceSeeding(unittest.TestCase):
    def test_only_immutable_titles_cross_trust_boundary(self):
        data=dict(policy="cove-openverse-commons-discovery-v1",candidates=[
            dict(sourceTitle="File:Original piano.ogg"),
            dict(sourceTitle="File:Original piano.ogg"),
            dict(sourceTitle="https://evil.test/A.mp3"),
            dict(sourceTitle="File:Unsafe/path.mp3"),
            dict(sourceTitle="File:Valid cello.mp3")])
        self.assertEqual(app.candidates(data),["File:Original piano.ogg","File:Valid cello.mp3"])
        with self.assertRaisesRegex(ValueError,"Unknown candidate"):
            app.candidates(dict(policy="unknown",candidates=[]))
    def test_cyclic_bounded_shards_cover_candidates_without_permanent_starvation(self):
        originals=["File:Open source %02d.ogg"%n for n in range(19)]
        per_run=[app.rotate_titles(originals,8,slot) for slot in (0,1,2)]
        self.assertTrue(all(len(run)==8 and len(set(run))==8 for run in per_run))
        self.assertEqual(len(set(sum(per_run,[]))),19)
        self.assertEqual(app.rotate_titles(originals[:3],8,0),originals[:3])
        with self.assertRaisesRegex(ValueError,"Unbounded"):
            app.rotate_titles(originals,9,0)

    def test_no_unscoped_writes_and_no_claims_of_copyright(self):
        with patch.dict(app.os.environ,{},clear=True):
            with self.assertRaises(ValueError):app.submit(["File:Original.ogg"],"not authorized")
        client=Client()
        with patch.dict(app.os.environ,{"COVE_MUSIC_COMMONS_SEED_ENABLED":"1"}):
            result=app.submit(["File:Original piano.ogg"],"fore_svc_"+"a"*50,client)
        self.assertEqual(result["queued"],1)
        self.assertFalse(result["publicationAuthorized"])
        self.assertEqual(client.calls[0].full_url,app.API)
        self.assertEqual(json.loads(client.calls[0].data)["titles"],["File:Original piano.ogg"])
if __name__=="__main__":unittest.main()

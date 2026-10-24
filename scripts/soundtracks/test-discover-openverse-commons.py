"""No-network Openverse/Commons read-only discovery tests."""
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location("openverse_discovery",
    pathlib.Path(__file__).with_name("discover-openverse-commons.py"))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

def result():
    return dict(id="index-1",foreign_landing_url=
                "https://commons.wikimedia.org/wiki/File:Beethoven_Piano_Sonata.ogg",
                license="by-sa",license_url="https://creativecommons.org/licenses/by-sa/4.0/")

def page():
    return dict(title="File:Beethoven Piano Sonata.ogg",pageid=98760,
                imageinfo=[dict(sha1="a"*40,size=10000,mime="audio/ogg",
                                url="https://upload.wikimedia.org/wikipedia/commons/a/aa/Sonata.ogg",
                                metadata=[],extmetadata=dict(
                                    LicenseShortName=dict(value="CC BY-SA 4.0"),
                                    LicenseUrl=dict(value="https://creativecommons.org/licenses/by-sa/4.0/"),
                                    Artist=dict(value="A Performer")))],
                revisions=[dict(revid=51,timestamp="2026-05-01T00:00:00Z",
                                slots=dict(main=dict(content="{{Information|source=Own work}}")))])

class OpenverseIsolatedDiscovery(unittest.TestCase):
    def test_rechecks_exact_commons_file_instead_of_trusting_openverse_license(self):
        c=module.exact_candidate(result(),page())
        self.assertEqual(c["id"],"cm_98760")
        self.assertEqual(c["sourceSha1"],"a"*40)
        self.assertEqual(c["licenseCode"],"CC-BY-SA")
        self.assertEqual(c["evidence"]["rightsStatus"],"DISCOVERY_ONLY_NEEDS_RECORDING_VERIFICATION")
        self.assertEqual(len(c["evidenceSha256"]),64)
    def test_untrusted_sources_and_conflicts_never_enter_proposals(self):
        for landing in ("https://freemusicarchive.org/music/test",
                        "https://commons.wikimedia.org.evil.test/wiki/File:Test.ogg",
                        "https://commons.wikimedia.org/wiki/File:Test.ogg?redirect=1",
                        "http://commons.wikimedia.org/wiki/File:Test.ogg"):
            self.assertIsNone(module.commons_title({"foreign_landing_url":landing}))
        bad=page()
        bad["imageinfo"][0]["metadata"]=[dict(name="license",value="CC BY-NC-SA")]
        self.assertIsNone(module.exact_candidate(result(),bad))
        bad=page()
        bad["imageinfo"][0]["extmetadata"]["LicenseShortName"]["value"]="CC BY-NC-SA 4.0"
        self.assertIsNone(module.exact_candidate(result(),bad))
        bad=page()
        bad["imageinfo"][0]["sha1"]="b"*40
        # A different master may be discovered as a NEW candidate, never
        # retained under stale evidence; existing row becomes held on upsert.
        candidate=module.exact_candidate(result(),bad)
        self.assertNotEqual(candidate["evidenceSha256"],
                            module.exact_candidate(result(),page())["evidenceSha256"])
    def test_bounded_one_page_search_and_no_download_of_audio(self):
        calls=[]
        def fake(url,opener=None):
            calls.append(url)
            if "openverse.org" in url:
                return dict(results=[result(),result()])
            return dict(query=dict(pages=[page()]))
        with patch.object(module,"read_json",side_effect=fake):
            output=module.discover(queries=1,max_verifications=1,pause=lambda _:None)
        self.assertEqual(output["verified"],1)
        self.assertEqual(len(output["candidates"]),1)
        self.assertEqual(len(calls),2)
        self.assertIn("page=1",calls[0])
        self.assertIn("page_size=20",calls[0])
        self.assertIn("source=wikimedia_audio",calls[0])
        self.assertNotIn("category=",calls[0],
                         "Commons audio indexing is incompatible with Openverse category=music")
        self.assertEqual(output["indexedResults"],2)
        self.assertEqual(output["nonCommonsResults"],0)
        self.assertEqual(output["heldAfterCommonsVerification"],0)
        self.assertNotIn(".ogg",calls[0])
    def test_non_wikimedia_index_hits_are_diagnostic_only(self):
        inspected=[]
        def response(url,opener=None,size=500000):
            inspected.append(url)
            return {"results":[
                {"foreign_landing_url":"https://freemusicarchive.org/music/example"},
                {"foreign_landing_url":"https://commons.wikimedia.org.evil.example/wiki/File:Other.ogg"}
            ]}
        with patch.object(module,"read_json",side_effect=response):
            report=module.discover(queries=1,max_verifications=3,pause=lambda _:None)
        self.assertEqual(report["indexedResults"],2)
        self.assertEqual(report["nonCommonsResults"],2)
        self.assertEqual(report["verified"],0)
        self.assertEqual(report["candidates"],[])
        self.assertIn("source=wikimedia_audio",inspected[0])

    def test_commons_native_category_results_are_verified_without_openverse_hits(self):
        calls=[]
        def response(url,opener=None,size=500000):
            calls.append(url)
            if "api.openverse.org" in url:
                return {"results":[]}
            return {"query":{"pages":[page()]}}
        with patch.object(module,"read_json",side_effect=response):
            report=module.discover(queries=1,max_verifications=2,pause=lambda _:None)
        self.assertEqual(report["openverseVerified"],0)
        self.assertEqual(report["commonsVerified"],2)
        self.assertEqual(report["commonsCategoryQueries"],2)
        self.assertEqual(len(report["candidates"]),1,
                         "Repeated exact Commons originals are idempotent")
        self.assertEqual(report["candidates"][0]["discoveryProvider"],"commons")
        self.assertEqual(report["candidates"][0]["evidence"]["discovery"],"commons")
        self.assertEqual(report["candidates"][0]["evidence"]["sourceSha1"],"a"*40)
        self.assertTrue(any("generator=categorymembers" in u for u in calls))
        self.assertTrue(any("gcmlimit=2" in u for u in calls), "Generator page must not exceed remaining verification budget")
        self.assertFalse(any("upload.wikimedia.org" in u for u in calls),
                         "Discovery must never download source audio")

    def test_commons_tracking_queries_are_canonicalized_but_security_queries_are_denied(self):
        good=page()
        good["imageinfo"][0]["url"]+="?utm_source=commons.wikimedia.org&utm_content=original"
        candidate=module.exact_candidate(result(),good)
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate["sourceFileUrl"],
                         "https://upload.wikimedia.org/wikipedia/commons/a/aa/Sonata.ogg")
        bad=page()
        bad["imageinfo"][0]["url"]+="?token=secret"
        self.assertIsNone(module.exact_candidate(result(),bad))
        bad["imageinfo"][0]["url"]="https://evil.test/wikipedia/commons/a/aa/Sonata.ogg"
        self.assertIsNone(module.exact_candidate(result(),bad))
        bad["imageinfo"][0]["url"]="https://upload.wikimedia.org/wikipedia/commons/a/aa/Sonata.ogg#anything"
        self.assertIsNone(module.exact_candidate(result(),bad))

    def test_commons_conflicts_and_unlicensed_recordings_remain_held(self):
        claim=page()
        claim["imageinfo"][0]["metadata"]=[{"name":"license","value":"CC BY-NC"}]
        with patch.object(module,"read_json",return_value={"query":{"pages":[claim]}}):
            data=module.commons_category_candidates(1,2,pause=lambda _:None)
        self.assertEqual(data["verified"],1)
        self.assertEqual(data["candidates"],[])
        self.assertEqual(data["held"],1)
        with patch.object(module,"read_json",return_value={"error":{"code":"maxlag"}}):
            with self.assertRaisesRegex(ValueError,"authoritative"):
                module.commons_category_candidates(1,2,pause=lambda _:None)

    def test_category_cursor_fences_generator_batches_and_rotates_by_campaign(self):
        old_cursor="file|oldtoken|123"
        new_cursor="file|nexttoken|987"
        cat=module.COMMONS_CATEGORIES[0]
        seen=[]
        def remote(url,opener=None,size=500000):
            seen.append(url)
            return {"query":{"pages":[page()]},
                    "continue":{"gcmcontinue":new_cursor}}
        with patch.object(module.time,"time",return_value=0):
            with patch.object(module,"read_json",side_effect=remote):
                out=module.commons_category_candidates(
                    categories=1,max_verifications=3,
                    continuations={cat:old_cursor},pause=lambda _:None)
        self.assertEqual(out["verified"],1)
        self.assertEqual(out["nextCursors"][cat],new_cursor)
        parsed=module.urllib.parse.parse_qs(module.urllib.parse.urlsplit(seen[0]).query)
        self.assertEqual(parsed["gcmcontinue"],[old_cursor])
        self.assertEqual(parsed["gcmlimit"],["3"])
        with patch.object(module.time,"time",return_value=0):
            with self.assertRaisesRegex(ValueError,"Malformed"):
                module.commons_category_candidates(1,2,continuations={cat:"bad"+chr(10)+"name"},
                                                  pause=lambda _:None)

    def test_isolated_cursor_is_committed_after_idempotent_candidate_writes(self):
        category=module.COMMONS_CATEGORIES[0]
        seen=[]
        class Reply:
            status=200
            def __init__(self,data):self.data=data
            def __enter__(self):return self
            def __exit__(self,*_):return False
            def read(self,maximum):return module.json.dumps(self.data).encode()
        class Client:
            def open(self,req,timeout=30):
                seen.append(req)
                body=module.json.loads(req.data)
                if body["sql"].startswith("SELECT"):
                    rows=[dict(category=category,generator_cursor="file|oldtoken|123")]
                else:
                    rows=[]
                return Reply(dict(success=True,result=[dict(success=True,results=rows)]))
        client=Client()
        sample=module.exact_candidate(result(),page(),"commons",category)
        report={
            "policy":"cove-openverse-commons-discovery-v1",
            "candidates":[sample],
            "searches":2,"verified":1,"openverseSearches":1,
            "openverseVerified":0,"commonsCategoryQueries":1,
            "commonsVerified":1,"processingMs":180,
            "commonsNextCursors":{category:"file|nexttoken|987"},
        }
        with patch.dict(module.os.environ,{"COVE_MUSIC_OPEN_DISCOVERY_ENABLED":"1",
                                            "CLOUDFLARE_ACCOUNT_ID":module.ACCOUNT},clear=True):
            self.assertEqual(module.load_isolated_cursors("fake-secret",client),
                             {category:"file|oldtoken|123"})
            self.assertEqual(module.record_isolated(report,"fake-secret",client),1)
        commands=[module.json.loads(request.data)["sql"] for request in seen]
        self.assertEqual(len(commands),5)
        self.assertIn("music_open_source_candidates",commands[1])
        self.assertIn("music_open_discovery_runs",commands[2])
        self.assertIn("music_open_discovery_runs",commands[3])
        self.assertIn("music_open_discovery_cursors",commands[4])
        self.assertTrue(all("/d1/database/"+module.MUSIC_DB+"/query" in request.full_url
                            for request in seen))

    def test_disabled_writes_fail_closed(self):
        with patch.dict(module.os.environ,{},clear=True):
            with self.assertRaisesRegex(ValueError,"not enabled"):
                module.record_isolated({"candidates":[]},token="anything")
if __name__=="__main__":unittest.main()

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
        self.assertNotIn(".ogg",calls[0])
    def test_disabled_writes_fail_closed(self):
        with patch.dict(module.os.environ,{},clear=True):
            with self.assertRaisesRegex(ValueError,"not enabled"):
                module.record_isolated({"candidates":[]},token="anything")
if __name__=="__main__":unittest.main()

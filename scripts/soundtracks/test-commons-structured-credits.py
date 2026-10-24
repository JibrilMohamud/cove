"""Offline exact-master evidence/credit regression tests (no network or secrets)."""
import importlib.util
import pathlib
import unittest

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,pathlib.Path(__file__).with_name(path))
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

meta=load("commons_credits_test","commons-structured-credits.py")
curate=load("curator_credits_test","curate-source-license.py")

def track(**change):
    row=dict(
        id="cm_91234567", title="Beethoven - Piano Sonata No. 1",
        source_title="File:Beethoven - Piano Sonata No. 1.ogg",
        source_sha1="a"*40, source_size=1048576, mime="audio/ogg",
        status="pending_review",quality_status="pending",dossier_json="{}",
        license_code="CC-BY-SA",license_url="https://creativecommons.org/licenses/by-sa/4.0/",
        license_statement="CC BY-SA 4.0", source_page_url="https://commons.wikimedia.org/wiki/File%3ABeethoven",
        source_file_url="https://upload.wikimedia.org/wikipedia/commons/a/ab/Beethoven.ogg",
        performer="Unknown performer", instruments_json="[]"
    )
    row.update(change)
    return row

def source(row=None,**change):
    row=row or track()
    info=dict(sha1=row["source_sha1"],size=row["source_size"],mime="audio/ogg",metadata=[],
              extmetadata=dict(LicenseShortName=dict(value="CC BY-SA 4.0"),
                               LicenseUrl=dict(value=row["license_url"]),
                               Artist=dict(value="Martha Goldstein"),
                               ImageDescription=dict(value="Composer: Ludwig van Beethoven<br>Performed by: Martha Goldstein")))
    page=dict(title=row["source_title"],imageinfo=[info],revisions=[
        dict(revid=60123,timestamp="2026-01-01T00:00:00Z",slots=dict(main=dict(content="{{Information}}")))
    ])
    page.update(change)
    return dict(query=dict(pages=[page]))

class CommonsSourceReconciliation(unittest.TestCase):
    def test_valid_named_composer_and_performer_cannot_be_invented(self):
        row=track()
        data,issue=meta.inspect_commons_file(row,source(row))
        self.assertEqual(issue,"")
        self.assertEqual(data["composer"],"Ludwig van Beethoven")
        self.assertEqual(data["performer"],"Martha Goldstein")
        self.assertEqual(data["evidence"]["sourceSha1"],row["source_sha1"])
        self.assertEqual(len(data["evidence"]["evidenceSha256"]),64)
        result,issue,updated=curate.reconciled_candidate(
            row,lambda r:meta.inspect_commons_file(r,source(r)))
        self.assertEqual(issue,"")
        self.assertEqual(result["composer"],"Ludwig van Beethoven")
        self.assertEqual(result["performer"],"Martha Goldstein")
        dossier,_=curate.prepare_release(updated,result)
        self.assertEqual(dossier["sourceReliance"]["metadataEvidence"]["policy"],"commons-file-credit-v1")
    def test_holds_uncorroborated_and_changed_originals(self):
        row=track()
        for mutate,problem in (
            (dict(title="File:Other.ogg"),"commons_page_identity_changed"),
            (dict(imageinfo=[dict(sha1="b"*40,size=row["source_size"],mime="audio/ogg",
                                  extmetadata={})]),"commons_audio_master_changed"),
        ):
            with self.subTest(problem=problem):
                data,why=meta.inspect_commons_file(row,source(row,**mutate))
                self.assertEqual(data,{})
                self.assertEqual(why,problem)
        wrong=source(row)
        wrong["query"]["pages"][0]["imageinfo"][0]["extmetadata"]["LicenseShortName"]["value"]="CC BY-NC-SA 4.0"
        self.assertEqual(meta.inspect_commons_file(row,wrong)[1],"commons_license_changed")
        conflict=source(row)
        conflict["query"]["pages"][0]["revisions"][0]["slots"]["main"]["content"]="{{Information|Source=Free Music Archive}}"
        self.assertEqual(meta.inspect_commons_file(row,conflict)[1],"commons_conflicting_source_claim")
    def test_provenance_conflicts_must_not_automatically_clear(self):
        row=track(performer="Another Performer",title="Sonata in C by Beethoven",source_title="File:Sonata in C by Beethoven.ogg")
        result,reason,_=curate.reconciled_candidate(
            row,lambda r:meta.inspect_commons_file(r,source(r)))
        self.assertIsNone(result)
        self.assertEqual(reason,"commons_performer_conflict")
        mystery=track(title="Contemporary Piano Piece",source_title="File:Contemporary Piano Piece.ogg")
        event=source(mystery)
        event["query"]["pages"][0]["imageinfo"][0]["extmetadata"]["ImageDescription"]["value"]="Composer: Living Composer<br>Performed by: Martha Goldstein"
        result,reason,_=curate.reconciled_candidate(mystery,lambda r:meta.inspect_commons_file(r,event))
        self.assertIsNone(result)
        self.assertEqual(reason,"unverified_composition_or_source_composer")
    def test_no_role_labels_cannot_autofill_performer(self):
        row=track()
        event=source(row)
        event["query"]["pages"][0]["imageinfo"][0]["extmetadata"]["ImageDescription"]["value"]="Beautiful classical piano track"
        event["query"]["pages"][0]["imageinfo"][0]["extmetadata"]["Artist"]["value"]="Uploader Nickname"
        data,why=meta.inspect_commons_file(row,event)
        self.assertEqual(data,{})
        self.assertEqual(why,"commons_no_explicit_role_evidence")
    def test_existing_known_good_source_path_unmodified(self):
        row=track(performer="musician: Martha Goldstein")
        first,issue=curate.choose_candidate(row)
        self.assertIsNotNone(first)
        resolved,reason,unchanged=curate.reconciled_candidate(row,lambda _:self.fail("unexpected API call"))
        self.assertEqual(resolved,first)
        self.assertEqual(reason,issue)
        self.assertIs(unchanged,row)

if __name__=="__main__":
    unittest.main()

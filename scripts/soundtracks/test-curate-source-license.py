#!/usr/bin/env python3
"""Standalone fail-closed regression tests. No credential or network is used."""
import hashlib
import importlib.util
import io
import pathlib
import tempfile
import unittest
from types import SimpleNamespace

path=pathlib.Path(__file__).with_name('curate-source-license.py')
spec=importlib.util.spec_from_file_location('cove_curator',path)
curator=importlib.util.module_from_spec(spec)
spec.loader.exec_module(curator)

def candidate(**overrides):
    row=dict(
        id='cm_300',title='Bach Sinfonien02',composer='',performer='musician: Randolph Hokanson',
        license_code='CC-BY-SA',license_url='https://creativecommons.org/licenses/by-sa/2.0/',
        license_statement='CC BY-SA 2.0',source_title='File:Bach Sinfonien02.ogg',
        source_sha1='a'*40,source_size=3000,mime='audio/ogg',
        source_page_url='https://commons.wikimedia.org/wiki/File%3ABach_Sinfonien02.ogg',
        source_file_url='https://upload.wikimedia.org/wikipedia/commons/a/ab/Bach_Sinfonien02.ogg',
        status='pending_review',quality_status='pending',dossier_json='{}',review_version=0,
        instruments_json='["piano"]')
    row.update(overrides)
    return row

class SoundtrackCurationTests(unittest.TestCase):
    def test_simple_source_is_explicitly_machine_reviewed_and_us_only(self):
        prof,reason=curator.choose_candidate(candidate())
        self.assertEqual(reason,'')
        self.assertEqual(prof['composer'],'Johann Sebastian Bach')
        self.assertEqual(prof['performer'],'Randolph Hokanson')
        dossier,approval=curator.prepare_release(candidate(),prof)
        self.assertEqual(dossier['reviewMethod'],'source_license')
        self.assertEqual(dossier['sourceReliance']['sourceSha1'],'a'*40)
        self.assertEqual(approval['territories'],['US'])
        self.assertEqual(approval['reviewer'],'COVE-SOURCE-AUTOMATION')
        for k in ('composition','arrangement','lyrics','performance','master'):
            self.assertGreaterEqual(len(dossier[k]['basis']),40)
            self.assertEqual(len(dossier[k]['evidenceUrls']),2)

    def test_holds_all_ambiguous_or_previously_reviewed_candidates(self):
        for override in (
            dict(status='ready'),dict(quality_status='passed'),
            dict(dossier_json='{"unresolved":["known rights hold"]}'),
            dict(license_code='CC-BY-NC'),dict(license_url='https://evil.test/license'),
            dict(title='Bach-Busoni Chorale'),dict(title='Bartok concerto'),
            dict(title='Bach arrangement of Vivaldi'),
            dict(performer='Johann Sebastian Bach'),dict(performer='composer: Bach'),
            dict(performer=''),dict(performer='Unknown performer'),
            dict(source_sha1='not-a-checksum'),dict(source_size=0),
            dict(source_file_url='https://evil.test/file.ogg'),
            dict(source_page_url='https://evil.test/wiki/File:fake')
        ):
            with self.subTest(override=override):
                prof,reason=curator.choose_candidate(candidate(**override))
                self.assertIsNone(prof)
                self.assertTrue(reason)

    def test_extended_historical_composers_are_source_reliant_not_invented(self):
        cases=(("Ludwig van Beethoven - Sonata, 1st movement","Randolph Hokanson"),
               ("Wolfgang Amadeus Mozart - Minuet","Martha Goldstein (musician)"),
               ("Robert Schumann - Fantasie","Neal and Nancy O'Doan"),
               ("Domenico Zipoli - Gavotte","Martha Goldstein"))
        for title,artist in cases:
            with self.subTest(title=title):
                profile,reason=curator.choose_candidate(candidate(title=title,performer=artist,instruments_json='[]'))
                self.assertEqual(reason,'')
                self.assertEqual(profile['instruments'],['unspecified'])
                self.assertTrue(profile['performer'])
        for artist in ("See above","Wolfgang Amadeus Mozart","unknown performer","composer: Beethoven"):
            with self.subTest(artist=artist):
                profile,_=curator.choose_candidate(candidate(title="Wolfgang Amadeus Mozart - Minuet",performer=artist))
                self.assertIsNone(profile)
        profile,_=curator.choose_candidate(candidate(title="Robert Schumann - Lieder",performer="Martha Goldstein"))
        self.assertIsNone(profile,"Vocal material must not be automatically treated as lyric-free")

    def test_media_download_is_pinned_and_checksum_checked(self):
        for value in (
            'http://upload.wikimedia.org/wikipedia/commons/a.ogg',
            'https://upload.wikimedia.org.evil.test/wikipedia/commons/a.ogg',
            'https://user@upload.wikimedia.org/wikipedia/commons/a.ogg',
            'https://upload.wikimedia.org/wikipedia/commons/a.ogg?redirect=https://localhost',
            'https://upload.wikimedia.org/wikipedia/commons/a.svg',
            'https://upload.wikimedia.org/wikipedia/commons/a.ogg#fragment'
        ):
            with self.subTest(url=value),self.assertRaises(ValueError):
                curator.trusted_media_url(value)
        self.assertEqual(curator.trusted_media_url('https://upload.wikimedia.org/wikipedia/commons/a.ogg?utm_source=commons'),
            'https://upload.wikimedia.org/wikipedia/commons/a.ogg')
        content=b'small fake recording'
        row=candidate(source_size=len(content),source_sha1=hashlib.sha1(content).hexdigest())
        class Stream(io.BytesIO):
            status=200
            def __init__(self,data):
                super().__init__(data);self.headers={'Content-Length':str(len(data))}
            def __enter__(self):return self
            def __exit__(self,*_):self.close()
        class Opener:
            def __init__(self,data):self.data=data
            def open(self,*args,**kwargs):return Stream(self.data)
        with tempfile.TemporaryDirectory() as folder:
            file=pathlib.Path(folder)/'a.ogg'
            curator.download_original(row,file,Opener(content))
            self.assertEqual(file.read_bytes(),content)
            with self.assertRaisesRegex(ValueError,'SHA-1'):
                curator.download_original(row,file,Opener(b'z'+content[1:]))
            with self.assertRaisesRegex(ValueError,'content length'):
                curator.download_original(row,file,Opener(content+b'extra'))

    def test_dry_run_reads_only(self):
        class Client:
            def __init__(self):self.calls=[]
            def call(self,path,body=None):
                self.calls.append((path,body))
                assert body is None, 'Dry run must not call review write endpoints'
                return dict(records=[candidate()],nextCursor=None)
        c=Client()
        args=SimpleNamespace(max_scan=10,max_tracks=8,max_mib=160,max_minutes=20,apply=False,approve_source_license=False)
        receipts=curator.run(args,c,lambda path: self.fail('Dry run decoded audio'))
        self.assertEqual(receipts[0]['status'],'eligible_dry_run')
        self.assertEqual(len(c.calls),1)

    def test_bad_qa_never_approves_and_good_qa_uses_exact_version(self):
        class Client:
            def __init__(self):self.posts=[]
            def call(self,path,body=None):
                if body is None:
                    return dict(records=[candidate()],nextCursor=None) if '?' in path else dict(record=candidate())
                self.posts.append(body)
                return dict(version=body['version']+1)
        orig=curator.download_original
        curator.download_original=lambda detail,path:pathlib.Path(path).write_bytes(b'fixture')
        try:
            args=SimpleNamespace(max_scan=10,max_tracks=8,max_mib=160,max_minutes=20,apply=True,approve_source_license=True)
            def qa(peak):
                return dict(sourceSha1='a'*40,bytes=3000,integratedLufs=-16,
                            truePeakDbfs=peak,clippedSampleRatio=0,silenceRatio=.01)
            c=Client()
            failed=curator.run(args,c,lambda path:qa(+1.2))
            self.assertEqual(failed[0]['status'],'held_audio_qa')
            self.assertEqual([b['action'] for b in c.posts],['quality'])
            c=Client()
            passed=curator.run(args,c,lambda path:qa(-1.2))
            self.assertEqual(passed[0]['status'],'approved_awaiting_storage')
            self.assertEqual([b['action'] for b in c.posts],['quality','draft','approve'])
            self.assertEqual([b['version'] for b in c.posts],[0,1,2])
        finally:curator.download_original=orig

if __name__=='__main__':unittest.main()

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

    def test_boccherini_self_released_named_artist_master_still_requires_exact_match(self):
        title="BOCCHERINI Op30 n°5 G323 Mvt2 Minuetto - Jacques Lochet violin and synthesizer"
        for owner in ('Quinbrid','uploaded by artist User:Quinbrid','uploaded by artist: User:Quinbrid'):
            with self.subTest(artist=owner):
                row=candidate(title=title, source_title='File:'+title+'.ogg',
                    performer=owner,license_code='CC-BY-SA',
                    license_url='https://creativecommons.org/licenses/by-sa/4.0/',
                    license_statement='CC BY-SA 4.0',instruments_json='[]')
                profile,reason=curator.choose_candidate(row)
                self.assertEqual(reason,'')
                self.assertEqual(profile['composer'],'Luigi Boccherini')
                self.assertEqual(profile['period'],'classical')
                self.assertEqual(profile['performer'],'Jacques Lochet')
                self.assertEqual(profile['sourceLicensor'],'Quinbrid')
                self.assertEqual(profile['instruments'],['violin','synthesizer'])
                dossier,approval=curator.prepare_release(row,profile)
                self.assertIn('Quinbrid',dossier['attributionText'])
                self.assertIn('Jacques Lochet',dossier['attributionText'])
                self.assertEqual(approval['territories'],['US'])
        for change in (
            dict(performer='Luigi Boccherini (1743-1805)'),
            dict(performer='Unknown uploader'),
            dict(performer='Some unrelated author'),
            dict(license_code='CC-BY-NC',
                 license_url='https://creativecommons.org/licenses/by-nc/4.0/'),
            dict(license_code='PD',
                 license_url='https://commons.wikimedia.org/wiki/Commons:Licensing'),
            dict(source_title='File:an-unrelated-composition.ogg'),
            dict(title='BOCCHERINI Op30 n°5 - other performer violin and synthesizer'),
            dict(title='BOCCHERINI Op30 n°5 - Jacques Lochet violin and synthesizer remix'),
        ):
            with self.subTest(change=change):
                row=candidate(title=title,source_title='File:'+title+'.ogg',
                    performer='Quinbrid',license_code='CC-BY-SA',
                    license_url='https://creativecommons.org/licenses/by-sa/4.0/')
                row.update(change)
                profile,reason=curator.choose_candidate(row)
                self.assertIsNone(profile)
                self.assertTrue(reason)

    def test_ten_exact_self_recorded_serna_viol_masters_without_blanket_artist_trust(self):
        self.assertEqual(len(curator.SERNA_SELF_RECORDED_ORIGINALS),10)
        for recording_id, spec in curator.SERNA_SELF_RECORDED_ORIGINALS.items():
            with self.subTest(id=recording_id):
                title,composer,period=spec
                row=candidate(id=recording_id,title=title,performer='Phillipwserna',
                    source_title='File:'+title+'.ogg',license_code='CC-BY-SA',
                    license_url='https://creativecommons.org/licenses/by-sa/4.0/',
                    license_statement='CC BY-SA 4.0',instruments_json='[]')
                profile,reason=curator.choose_candidate(row)
                self.assertEqual(reason,'')
                self.assertEqual(profile['performer'],'Dr. Phillip W. Serna')
                self.assertEqual(profile['composer'],composer)
                self.assertEqual(profile['period'],period)
                self.assertEqual(profile['instruments'],['viol'])
                self.assertEqual(profile['sourceLicensor'],'Phillipwserna')
                self.assertTrue(profile['selfRecordedOriginal'])
                dossier,approval=curator.prepare_release(row,profile)
                self.assertIn('Phillipwserna',dossier['attributionText'])
                self.assertIn('all parts',dossier['sourceReliance']['declarationBasis'])
                self.assertEqual(approval['territories'],['US'])
                for change in (
                    {'performer':'unrelated uploader'},
                    {'performer':composer},
                    {'license_code':'CC-BY-NC','license_url':'https://creativecommons.org/licenses/by-nc/4.0/'},
                    {'license_code':'PD','license_url':'https://commons.wikimedia.org/wiki/Commons:Licensing'},
                    {'title':title+' - unauthorized remix'},
                    {'source_title':'File:some_other_recording.ogg'},
                ):
                    altered=dict(row,**change)
                    held,why=curator.choose_candidate(altered)
                    self.assertIsNone(held,why)
                unrelated=dict(row,id='cm_919999999')
                held,_=curator.choose_candidate(unrelated)
                self.assertFalse(held and held.get('selfRecordedOriginal'),
                    'The ten-record whitelist must never confer self-recorded status to other tracks')

    def test_self_published_historical_guitar_exact_master_and_licensor(self):
        cases=(
            ("Sor Op 31 No. 1","Fernando Sor"),
            ("Sor Op 35 No. 17","Fernando Sor"),
            ("Carulli Op 114 No. 1","Ferdinando Carulli"),
            ("Carulli Op 114 No. 2","Ferdinando Carulli"),
        )
        for title,composer in cases:
            with self.subTest(title=title):
                row=candidate(title=title,source_title='File:'+title+'.ogg',
                              performer='Jujutacular',
                              license_code='CC-BY-SA',
                              license_url='https://creativecommons.org/licenses/by-sa/3.0/',
                              license_statement='CC BY-SA 3.0',
                              instruments_json='[]')
                profile,reason=curator.choose_candidate(row)
                self.assertEqual(reason,'')
                self.assertEqual(profile['composer'],composer)
                self.assertEqual(profile['performer'],'Jujutacular')
                self.assertEqual(profile['period'],'classical')
                dossier,approval=curator.prepare_release(row,profile)
                self.assertIn('Jujutacular',dossier['attributionText'])
                self.assertEqual(approval['territories'],['US'])
                for change in (
                    {'performer':'Unknown performer'},
                    {'performer':composer},
                    {'source_title':'File:unrelated.ogg'},
                    {'license_code':'CC-BY-NC','license_url':'https://creativecommons.org/licenses/by-nc/3.0/'},
                    {'title':title+' remix'},
                ):
                    no=dict(row,**change)
                    result,_=curator.choose_candidate(no)
                    self.assertIsNone(result)

    def test_source_named_performer_is_correlated_before_commercial_reliance(self):
        cases=(
            ("Schubert's Impromptu no. 2 in E-flat major, D.899 - Chiara Bertoglio", "Chiara Bertoglio", "Franz Schubert"),
            ("Stefano Ligoratti - Haydn's Keyboard Sonata No. 2 (Partita) in B-flat major", "Stefano Ligoratti", "Joseph Haydn"),
            ("Ivan Ilić - Haydn's Keyboard Sonata No. 32 in B minor", "Ivan Ilić", "Joseph Haydn"),
            ("Marek Kozak - Haydn's Keyboard Sonata No. 52 in E-flat major", "Marek Kozak", "Joseph Haydn"),
        )
        for title,person,composer in cases:
            with self.subTest(title=title):
                row=candidate(title=title,performer=person,source_title='File:'+title+'.ogg',
                              automated_triage_reason='Not eligible for machine approval; composer not in narrow sourced-title mapping')
                profile,reason=curator.choose_candidate(row)
                self.assertEqual(reason,'')
                self.assertEqual(profile['performer'],person)
                self.assertEqual(profile['composer'],composer)
                for wrong in ("Unknown performer",composer,"Different musician"):
                    changed=dict(row,performer=wrong)
                    prof,reason=curator.choose_candidate(changed)
                    self.assertIsNone(prof,"The source title and performer metadata must agree")
        for title,person in (
            ("Ravel's Jeux d'eau, M. 30 - Anna Sutyagina","Anna Sutyagina"),
            ("Schubert's Lied in F minor - Chiara Bertoglio","Chiara Bertoglio"),
        ):
            profile,_=curator.choose_candidate(candidate(title=title,performer=person))
            self.assertIsNone(profile,"Modern-composition or vocal exceptions must stay held")

    def test_more_historical_instrumental_licenses_still_require_named_performers(self):
        cases=(
            ("Johann Jacob Froberger - Tombeau", "Joan Benson", "Johann Jakob Froberger"),
            ("Jules Demersseman - Introduction and Polanaise", "Arthur Grossman", "Jules Demersseman"),
            ("Scheidemann D minor Preambulum 1", "Random pipings", "Heinrich Scheidemann"),
            ("Joachim Andersen - Etude 3 for Solo Flute", "Scott Goff (flute)", "Joachim Andersen"),
            ("Blavet - Sonata No. 1 in G major", "Albert Tipton (flute) and Mary Norris (piano)", "Michel Blavet"),
            ("Benedetto Marcello - Flute Sonata in F major", "Albert Tipton (flute) and Mary Norris (piano)", "Benedetto Marcello"),
            ("Weber - Grand Duo Concertant for clarinet and piano - 1. Allegro con fuoco", "William McColl (clarinet) and Joseph Levine (piano)", "Carl Maria von Weber"),
            ("Paderewski - Minuet in G, Op. 14 no 1", "Ignacy Jan Paderewski, performer: Markus Staab", "Ignacy Jan Paderewski"),
            ("Scriabin - Feuillet d'album - Tjako van Schie - piano", "Tjako van Schie", "Alexander Scriabin"),
            ("Studio KonKon - Handel's Keyboard Suite in G minor, HWV 432 - III. Allegro (piano)", "Studio KonKon", "George Frideric Handel"),
        )
        for title,artist,composer in cases:
            with self.subTest(title=title):
                row=candidate(title=title,performer=artist,
                    source_title="File:"+title+".ogg",
                    automated_triage_reason="Not eligible for machine approval; composer not in narrow sourced-title mapping",
                    instruments_json='[]')
                profile,reason=curator.choose_candidate(row)
                self.assertEqual(reason,'')
                self.assertEqual(profile["composer"],composer)
                self.assertNotEqual(profile["performer"],composer)
                for excluded in ("Unknown performer",composer,"composer: "+composer):
                    held,why=curator.choose_candidate({**row,"performer":excluded})
                    self.assertIsNone(held,why)
                for blocked in ("CC-BY-NC","CC-BY-NC-SA"):
                    held,why=curator.choose_candidate({**row,"license_code":blocked})
                    self.assertIsNone(held,why)
        title="Studio KonKon - Handel's Keyboard Suite in G minor, HWV 432 - III. Allegro (piano)"
        profile,_=curator.choose_candidate(candidate(title=title,performer="Unrelated artist"))
        self.assertIsNone(profile,"Performer named in track title must match source credit")
        profile,_=curator.choose_candidate(candidate(title="Weber - Grand Duo Concertant arranged by Ravel",performer="William McColl"))
        self.assertIsNone(profile,"Arrangements never pass the machine fast lane")

    def test_policy_reconsideration_reads_only_explicitly_triaged_queue(self):
        title="Schubert's Impromptu no. 3 in G-flat major, D.899 - Chiara Bertoglio"
        prior=candidate(title=title,performer="Chiara Bertoglio",
            automated_triage_reason="Not eligible for machine approval; composer not in narrow sourced-title mapping")
        class Client:
            def __init__(self):self.paths=[]
            def call(self,path,body=None):
                self.paths.append(path)
                self.assertNoMutation(body)
                return {"records":[prior],"nextCursor":None}
            def assertNoMutation(self,body):
                if body is not None:raise AssertionError("Reconsideration dry run cannot modify rights decisions")
        c=Client()
        args=SimpleNamespace(max_scan=25,max_tracks=8,max_triage=0,max_mib=160,max_minutes=20,
            apply=False,approve_source_license=False,reconsider_triaged=True)
        receipt=curator.run(args,c,lambda _:self.fail("Dry run cannot fetch audio"))
        self.assertEqual(receipt[0]["status"],"eligible_dry_run")
        self.assertIn("automation=triaged",c.paths[0])
        args.reconsider_triaged=False
        c=Client()
        curator.run(args,c,lambda _:self.fail("Dry run cannot fetch audio"))
        self.assertIn("automation=1",c.paths[0])

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

    def test_noneligible_music_is_triaged_not_copyright_rejected(self):
        row=candidate(title='Unknown experimental vocal recording')
        class Client:
            def __init__(self):self.calls=[]
            def call(self,path,body=None):
                self.calls.append((path,body))
                if body is None:
                    return {'records':[row], 'nextCursor':None} if '?' in path else {'record':row}
                return {'version':body['version']+1}
        args=SimpleNamespace(max_scan=10,max_tracks=8,max_triage=1,max_mib=160,
                             max_minutes=20,apply=True,approve_source_license=True)
        c=Client()
        result=curator.run(args,c,lambda _:self.fail('Ambiguous audio must never be downloaded'))
        self.assertEqual(result[0]['status'],'requires_manual_review')
        writes=[body for _,body in c.calls if body is not None]
        self.assertEqual(len(writes),1)
        self.assertEqual(writes[0]['action'],'triage')
        self.assertIn('staff rights review',writes[0]['reason'])
        c=Client()
        args.apply=False
        result=curator.run(args,c,lambda _:self.fail('Dry run decoded audio'))
        self.assertEqual(result[0]['status'],'manual_review_dry_run')
        self.assertTrue(all(body is None for _,body in c.calls))

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

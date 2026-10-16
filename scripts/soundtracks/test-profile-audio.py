import importlib.util,json,pathlib,subprocess,tempfile,unittest
import numpy as np

def load(name,file):
    spec=importlib.util.spec_from_file_location(name,pathlib.Path(__file__).with_name(file));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
analyzer=load('profile_audio','profile-audio.py');runner=load('run_profiles','run-profiles.py')
class ProfileTests(unittest.TestCase):
    def test_full_signal_has_distinct_regions(self):
        with tempfile.TemporaryDirectory() as directory:
            file=pathlib.Path(directory)/'fixture.wav'
            # Six quiet seconds, six louder seconds, then quiet again.
            subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:duration=18:sample_rate=16000','-af',"volume=if(between(t\\,6\\,12)\\,0.8\\,0.08):eval=frame",str(file)],check=True)
            report=analyzer.analyze(file)
            self.assertTrue(report['decodedFully']);self.assertIsNone(report['semantics'])
            self.assertGreater(report['loudness']['rmsDynamicRangeDb'],10)
            self.assertEqual(report['structure']['timeline'][0]['start'],0)
            self.assertAlmostEqual(report['structure']['timeline'][-1]['end'],18,places=1)
            self.assertTrue(report['structure']['climaxes'])
            self.assertTrue(report['structure']['quietSections'])
            self.assertIsNone(report['signal']['tempoBpm'])
            json.dumps(report,allow_nan=False)
    def test_model_windows_cover_recording_and_stay_bounded(self):
        for duration in [1,10,11,90,7200]:
            windows=analyzer.model_windows(duration)
            self.assertLessEqual(len(windows),8)
            self.assertAlmostEqual(windows[-1][1],duration)
            self.assertEqual(windows[0][0],0)
            self.assertTrue(all(a<b<=duration for a,b in windows))
            self.assertTrue(all(windows[i][1]<=windows[i+1][0]+.001 for i in range(len(windows)-1)))
    def test_no_arbitrary_host_or_path(self):
        for value in ['https://evil.test/a','/api/fore/soundtracks/recordings/cm_1/audio?redirect=x','/api/fore/soundtracks/recordings/cm_2/audio']:
            with self.assertRaises(ValueError):runner.audio_path('cm_1',value)
        self.assertTrue(runner.audio_path('cm_1','/api/fore/soundtracks/recordings/cm_1/audio').startswith(runner.ORIGIN))
if __name__=='__main__':unittest.main()

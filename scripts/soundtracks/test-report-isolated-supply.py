import datetime as dt
import importlib.util
import pathlib
import unittest

spec=importlib.util.spec_from_file_location("daily_music_report",
    pathlib.Path(__file__).with_name("report-isolated-supply.py"))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class TestDetachedMusicDailyReport(unittest.TestCase):
    def test_boundaries_and_unpriced_are_preserved(self):
        commands=[]
        def read(sql,params,token):
            commands.append(sql)
            self.assertEqual(token,"fake-isolated")
            if "FROM music_stage_events" in sql:
                return [dict(stage="analysis_complete",outcome="needs_review",count=2,
                             processing_ms=9000,priced_microusd=None,unpriced_events=2,bytes=1024)]
            if "UNION ALL" in sql:
                return [dict(stage="audio_qa",status="queued",count=3)]
            if "candidate_count" in sql:
                return [dict(candidate_count=7,source_conflict_holds=1,
                             human_reviewed_total=0,negotiated_contract_count=0,master_count=0)]
            return [dict(provider="openverse",runs=1,discovered=3)]
        d=module.collect("fake-isolated",dt.datetime(2026,10,24,tzinfo=dt.timezone.utc),read)
        self.assertEqual(len(commands),4)
        self.assertFalse(any("cove-production" in q or "soundtrack_recordings" in q for q in commands))
        self.assertIsNone(d["customerPlayableCertification"])
        self.assertEqual(d["stages"][0]["unpriced_events"],2)
        self.assertIsNone(d["stages"][0]["priced_microusd"])
        self.assertIn("not zero",d["costInterpretation"])
    def test_require_explicit_isolated_identity_and_read_only_queries(self):
        with self.assertRaises(ValueError):
            module.fetch("DELETE FROM music_masters",[],token="")
        with self.assertRaises(ValueError):
            module.fetch("DROP TABLE music_masters",[],token="not-an-identity")

if __name__=="__main__":unittest.main()

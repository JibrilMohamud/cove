#!/usr/bin/env python3
"""Operator-only detached MUSIC_DB daily throughput and actual-known-cost receipt.

No customer D1 reads. No misleading claims about production-ready recordings.
"""
import argparse
import datetime as dt
import json
import os
import pathlib
import urllib.request

ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9"
DB = "fe9a9dd2-64b8-451c-a356-9ec71d9ee211"
URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{DB}/query"
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def fetch(sql, params, token, opener=None):
    if not token or os.getenv("CLOUDFLARE_ACCOUNT_ID")!=ACCOUNT:
        raise ValueError("Explicit isolated D1 reporting credential required")
    allowed = ("SELECT", "WITH")
    if not sql.strip().upper().startswith(allowed):
        raise ValueError("Read-only detached reports only")
    data=json.dumps(dict(sql=sql,params=[str(x) for x in params])).encode()
    request=urllib.request.Request(URL,data=data,method="POST",headers={
        "Authorization":"Bearer "+token,"Content-Type":"application/json",
        "User-Agent":"CoveIsolatedMusicMetrics/1.0 (https://cove-puce-theta.vercel.app/help)"})
    client=opener or urllib.request.build_opener(NoRedirect)
    with client.open(request,timeout=30) as response:
        if response.status != 200:
            raise RuntimeError("Music-only metrics query unavailable")
        result=json.loads(response.read(200000))
    if not result.get("success") or not result.get("result", [{}])[0].get("success"):
        raise RuntimeError("Music-only metrics query rejected")
    return result["result"][0]["results"]

def collect(token,when=None,reader=fetch):
    at = when or dt.datetime.now(dt.timezone.utc)
    start=(at-dt.timedelta(days=1)).isoformat()
    stage=reader(
        "SELECT stage,outcome,COUNT(*) count,COALESCE(SUM(processing_ms),0) processing_ms,"
        " SUM(cost_microusd) priced_microusd,"
        " SUM(CASE WHEN cost_microusd IS NULL THEN 1 ELSE 0 END) unpriced_events,"
        " SUM(bytes_processed) bytes"
        " FROM music_stage_events WHERE recorded_at>=? GROUP BY stage,outcome ORDER BY stage,outcome",
        [start],token)
    backlog=reader(
        "SELECT 'intake' stage,status,COUNT(*) count FROM music_intake_jobs GROUP BY status"
        " UNION ALL SELECT 'audio_qa',status,COUNT(*) FROM music_quality_jobs GROUP BY status"
        " UNION ALL SELECT 'analysis',status,COUNT(*) FROM music_analysis_jobs GROUP BY status",
        [],token)
    sources=reader(
        "SELECT (SELECT COUNT(*) FROM music_open_source_candidates) candidate_count,"
        " (SELECT COUNT(*) FROM music_open_source_candidates WHERE status='held') source_conflict_holds,"
        " (SELECT COUNT(*) FROM music_human_reviews) human_reviewed_total,"
        " (SELECT COUNT(*) FROM music_contracts) negotiated_contract_count,"
        " (SELECT COUNT(*) FROM music_masters) master_count,"
        " (SELECT COUNT(*) FROM music_open_source_candidates c"
        " WHERE c.status='discovered' AND NOT EXISTS"
        " (SELECT 1 FROM music_open_technical_qa q WHERE q.candidate_id=c.id))"
        " open_technical_qa_backlog,"
        " (SELECT COUNT(*) FROM music_open_technical_qa WHERE status='measured')"
        " open_originals_technically_measured,"
        " (SELECT COUNT(*) FROM music_open_technical_qa WHERE status='held')"
        " open_originals_technical_holds,"
        " (SELECT COUNT(*) FROM music_open_review_cases WHERE status='needs_review'"
        " AND review_kind='rights_provenance') rights_review_cases,"
        " (SELECT COUNT(*) FROM music_open_review_cases WHERE status='needs_review'"
        " AND review_kind='quiet_suitability') quiet_review_cases",
        [],token)
    discovery=reader(
        "SELECT provider,COUNT(*) runs,SUM(searches) searches,SUM(verified) verified,"
        " SUM(discovered) discovered,SUM(processing_ms) processing_ms"
        " FROM music_open_discovery_runs WHERE recorded_at>=? GROUP BY provider",
        [start],token)
    return {
        "window":{"from":start,"to":at.isoformat()},
        "stages":stage,
        "backlog":backlog,
        "sourceAndReviewCounts":sources[0] if sources else {},
        "discovery":discovery,
        "openOriginalQaInterpretation":"Measured originals are unapproved private technical evidence only, never licensed or quiet by default.",
        "costInterpretation":"Only attested micro-USD totals are known; null/unpriced is not zero.",
        "customerPlayableCertification":None,
        "scope":"isolated_music_db_not_storefront_or_primary_d1",
    }

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--output",default="isolated-music-daily-report.json")
    p.add_argument("--dry-run",action="store_true")
    args=p.parse_args()
    if args.dry_run:
        print(json.dumps({"dryRun":True,"customerD1Queried":False}))
        return
    result=collect(os.environ.get("CLOUDFLARE_API_TOKEN",""))
    pathlib.Path(args.output).write_text(json.dumps(result,indent=2)+"\n")
    print(json.dumps({"stages":len(result["stages"]),"backlog":len(result["backlog"]),
                      "customerPlayableCertified":False,"output":args.output}))
if __name__=="__main__":main()

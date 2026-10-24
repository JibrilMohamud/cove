#!/usr/bin/env python3
"""Queue strictly unapproved Commons rights and quietness review cases in MUSIC_DB.

A source recording has technically decoded, not been licensed or cleared as quiet.
No customer database, publication outbox, master approvals or entitlement writes.
"""
import argparse
import datetime as dt
import importlib.util
import json
import os
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
def load_module():
    spec = importlib.util.spec_from_file_location(
        "cove_open_music_technical_qa", HERE / "qualify-isolated-commons.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

TECH = load_module()

def select_pending(token, limit=1, query=None):
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 2:
        raise ValueError("review_batch_out_of_range")
    query = query or TECH.d1
    return query(
        "SELECT c.id,c.source_title,c.source_page_url,c.source_sha1,c.license_code,"
        "c.license_url,c.evidence_json,c.evidence_sha256,q.source_sha256,"
        "q.report_sha256,q.source_evidence_sha256"
        " FROM music_open_source_candidates c"
        " JOIN music_open_technical_qa q ON q.candidate_id=c.id"
        " WHERE q.status='measured' AND q.rights_status='unreviewed'"
        " AND q.quiet_status='unreviewed' AND c.status='discovered'"
        " AND q.source_evidence_sha256=c.evidence_sha256"
        " AND NOT EXISTS(SELECT 1 FROM music_open_review_cases r"
        " WHERE r.candidate_id=c.id AND r.review_kind='rights_provenance')"
        " ORDER BY c.id LIMIT ?", [limit], token)

def make_cases(row):
    if (not re.fullmatch(r"cm_[0-9]{1,15}", str(row["id"])) or
        any(not re.fullmatch(r"[0-9a-f]{64}", str(row[key])) for key in
            ("source_sha256", "report_sha256", "evidence_sha256")) or
        row["source_evidence_sha256"] != row["evidence_sha256"] or
        row["license_code"] not in ("CC0","CC-BY","CC-BY-SA")):
        raise ValueError("review_evidence_not_stable")
    original = json.loads(row["evidence_json"])
    if not isinstance(original, dict):
        raise ValueError("review_original_evidence_not_object")
    author = str(original.get("rawArtist") or "").strip()[:240]
    origin_credit = str(original.get("rawCredit") or "").strip()[:500]
    title = str(row["source_title"])[:250]
    license_url = str(row["license_url"])[:300]
    source_page = str(row["source_page_url"])[:400]
    # Draft credits and license-reliance are not independently authenticated.
    draft = " / ".join(x for x in (title, author, origin_credit, license_url) if x)
    evidence = json.dumps({
        "schema":"cove.music.open.review.v1",
        "sourcePage":source_page, "sourceTitle":title,
        "sourceSha1":row["source_sha1"], "sourceSha256":row["source_sha256"],
        "sourceEvidenceSha256":row["evidence_sha256"],
        "technicalReportSha256":row["report_sha256"],
        "claimedLicenseCode":row["license_code"], "claimedLicenseUrl":license_url,
        "claimedPerformerOrCreator":author, "originalCreditText":origin_credit,
        "originalRevision":original.get("commonsRevision"),
        "provenanceAssessed":False, "recordingLicensed":False,
        "quietSuitable":False, "customerPlayable":False,
    },sort_keys=True,separators=(",",":"),ensure_ascii=False)
    return [
      ("rights_provenance","recording_license_upstream_reconciliation",draft,evidence),
      ("quiet_suitability","human_acoustic_quiet_calibration",draft,evidence)
    ]

def queue_case(token, row, case, query=None):
    query = query or TECH.d1
    kind, reason, attribution, evidence = case
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    query(
        "INSERT OR IGNORE INTO music_open_review_cases"
        "(candidate_id,review_kind,source_sha1,original_sha256,"
        "technical_report_sha256,discovery_evidence_sha256,reason,status,"
        "attribution_draft,evidence_json,recorded_at)"
        " SELECT c.id,?,c.source_sha1,q.source_sha256,q.report_sha256,"
        "c.evidence_sha256,?,'needs_review',?,?,?"
        " FROM music_open_source_candidates c"
        " JOIN music_open_technical_qa q ON q.candidate_id=c.id"
        " WHERE c.id=? AND q.status='measured' AND c.status='discovered'"
        " AND q.rights_status='unreviewed' AND q.quiet_status='unreviewed'"
        " AND q.source_sha256=? AND q.report_sha256=?"
        " AND q.source_evidence_sha256=c.evidence_sha256"
        " AND c.evidence_sha256=? AND c.source_sha1=?",
        [kind,reason,attribution,evidence,now,row["id"],row["source_sha256"],
         row["report_sha256"],row["evidence_sha256"],row["source_sha1"]],token)
    found=query(
        "SELECT review_kind,status,reason,original_sha256,technical_report_sha256,"
        "discovery_evidence_sha256 FROM music_open_review_cases"
        " WHERE candidate_id=? AND review_kind=?", [row["id"],kind],token)
    expected={"review_kind":kind,"status":"needs_review","reason":reason,
              "original_sha256":row["source_sha256"],
              "technical_report_sha256":row["report_sha256"],
              "discovery_evidence_sha256":row["evidence_sha256"]}
    if len(found)!=1 or found[0]!=expected:
        raise RuntimeError("review_case_not_durable_or_mismatched")

def run(token, apply=False, limit=1, query=None):
    query=query or TECH.d1
    rows=select_pending(token,limit,query)
    if apply and os.environ.get("COVE_MUSIC_REVIEW_APPLY")!="1":
        raise ValueError("private_review_case_admission_disabled")
    items=[]
    for row in rows:
        cases=make_cases(row)
        if apply:
            for case in cases:
                queue_case(token,row,case,query)
        items.append({"id":row["id"],"status":"needs_review" if apply
                      else "dry_run_review_dossier","holds":[x[0] for x in cases]})
    return {"sourceCandidates":len(rows),"casesCreated":len(rows)*2 if apply else 0,
            "items":items,"customerPublished":False,"rightsApproved":False,
            "quietApproved":False,"primaryD1Modified":False}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--max-recordings",type=int,default=1)
    parser.add_argument("--apply-isolated",action="store_true")
    parser.add_argument("--output",default="commons-review-cases.json")
    args=parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,120}\\.json",args.output):
        raise ValueError("unsafe_output_filename")
    token=os.environ.get("CLOUDFLARE_API_TOKEN","")
    result=run(token,args.apply_isolated,args.max_recordings)
    pathlib.Path(args.output).write_text(
        json.dumps(result,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")
    print(json.dumps(result,ensure_ascii=False))

if __name__=="__main__":
    main()

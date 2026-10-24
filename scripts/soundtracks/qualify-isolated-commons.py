#!/usr/bin/env python3
"""Bounded exact-Common-file acquisition and real full-audio QA on isolated compute.

Writes only detached MUSIC_DB and private music R2, never customer D1 or a
playable master. A successful result is a *technical* receipt, not a rights
review, quietness approval or customer publication.
"""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import re
import tempfile
import time
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9"
DATABASE = "fe9a9dd2-64b8-451c-a356-9ec71d9ee211"
BUCKET = "cove-music-supply-qa-20261023"
API = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{DATABASE}/query"
MAX_BYTES = 25 * 1024 * 1024
AGENT = "CoveOpenMusicTechnicalQA/1.0 (https://github.com/JibrilMohamud/cove)"

def load(filename, name):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

DISCOVERY = load("discover-openverse-commons.py", "verified_commons_discovery")
MEASURE = load("measure-audio.py", "verified_audio_measure")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None

OPENER = urllib.request.build_opener(NoRedirect)

def d1(sql, values, token, opener=OPENER):
    if not token or os.environ.get("CLOUDFLARE_ACCOUNT_ID") != ACCOUNT:
        raise ValueError("Dedicated detached MUSIC_DB identity required")
    body = json.dumps({"sql": sql, "params": [str(v) for v in values]}).encode()
    req = urllib.request.Request(API, data=body, method="POST", headers={
        "Authorization": "Bearer " + token, "Content-Type": "application/json",
        "User-Agent": AGENT})
    with opener.open(req, timeout=30) as res:
        if res.status != 200:
            raise RuntimeError("Isolated D1 query failed")
        payload = res.read(1000000)
    response = json.loads(payload)
    if not response.get("success") or not response.get("result") or not all(
            item.get("success") for item in response["result"]):
        raise RuntimeError("Isolated D1 statement rejected")
    return response["result"][0].get("results", [])

def claim_read(token, max_records=2, after=""):
    if not 1 <= max_records <= 2 or (after and not re.fullmatch(r"cm_[0-9]{1,15}", after)):
        raise ValueError("Technical QA scan must be bounded")
    return d1(
        "SELECT c.id,c.source_title,c.source_file_url,c.source_sha1,c.size_bytes,"
        " c.license_code,c.license_url,c.evidence_sha256 FROM music_open_source_candidates c"
        " WHERE c.status='discovered' AND c.id>? AND NOT EXISTS("
        " SELECT 1 FROM music_open_technical_qa q WHERE q.candidate_id=c.id)"
        " ORDER BY c.id LIMIT ?", [after, max_records], token)

def authoritative(row, opener=OPENER):
    title = row["source_title"]
    if not isinstance(title, str) or not re.fullmatch(r"File:.{4,240}\.(?:ogg|oga|mp3)", title, re.I):
        raise ValueError("invalid_commons_file_identity")
    page = DISCOVERY.verified_commons_title(title, opener)
    landing = "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(
        title.replace(" ", "_"), safe=":_()'")
    candidate = DISCOVERY.exact_candidate({"foreign_landing_url": landing}, page or {}, "commons")
    if not candidate:
        raise ValueError("authoritative_rights_or_original_hold")
    expected = {
        "id": row["id"], "sourceTitle": title,
        "sourceFileUrl": row["source_file_url"],
        "sourceSha1": row["source_sha1"], "sizeBytes": row["size_bytes"],
        "licenseCode": row["license_code"], "licenseUrl": row["license_url"],
    }
    for key, value in expected.items():
        if candidate.get(key) != value:
            raise ValueError("original_or_license_changed")
    if not re.fullmatch(r"[0-9a-f]{64}", str(row["evidence_sha256"])):
        raise ValueError("unverifiable_discovery_evidence")
    return candidate

def download_original(candidate, destination, opener=OPENER):
    uri = urllib.parse.urlsplit(candidate["sourceFileUrl"])
    if (uri.scheme != "https" or uri.hostname != "upload.wikimedia.org" or
        uri.port or uri.query or uri.fragment or uri.username or uri.password or
        not re.fullmatch(r"/wikipedia/commons/[^\s?]+\.(?:ogg|oga|mp3)", uri.path, re.I)):
        raise ValueError("untrusted_original_url")
    req = urllib.request.Request(uri.geturl(), headers={
        "User-Agent": AGENT, "Accept": "audio/ogg, audio/mpeg"})
    sha1, sha256 = hashlib.sha1(), hashlib.sha256()
    length = 0
    with opener.open(req, timeout=60) as response, pathlib.Path(destination).open("wb") as sink:
        if response.status != 200:
            raise ValueError("source_not_full_200")
        header = response.headers.get("Content-Length")
        if header is None or not header.isdigit() or int(header) != candidate["sizeBytes"]:
            raise ValueError("source_content_length_changed")
        for chunk in iter(lambda: response.read(1024 * 1024), b""):
            length += len(chunk)
            if length > MAX_BYTES or length > candidate["sizeBytes"]:
                raise ValueError("original_exceeds_byte_budget")
            sha1.update(chunk)
            sha256.update(chunk)
            sink.write(chunk)
    if length != candidate["sizeBytes"] or sha1.hexdigest() != candidate["sourceSha1"]:
        raise ValueError("original_sha1_or_size_mismatch")
    return {"sha256": sha256.hexdigest(), "bytes": length}

def validate_full_audio_quality(report):
    # Identical acoustic thresholds to the detached supplier-master QA gate.
    # Passing does NOT mean a recording is quiet, licensed, or publishable.
    ranges = {
        "durationSeconds": (20, 7200, False),
        "integratedLufs": (-40, -8, False),
        "truePeakDbfs": (-70, 0, False),
        "silenceRatio": (0, .25, True),
        "clippedSampleRatio": (0, .001, True),
    }
    if report.get("decodedFully") is not True:
        raise ValueError("full_audio_decode_incomplete")
    for key, (lo, hi, exclusive) in ranges.items():
        value = report.get(key)
        if (not isinstance(value, (int, float)) or isinstance(value, bool) or
            not math.isfinite(value) or value < lo or
            (value >= hi if exclusive else value > hi)):
            raise ValueError("full_audio_quality_not_eligible")
    return True

def r2_put_verified(client, key, file, digest, size):
    # Never produce publicly routable URLs. Verify a full private read-back
    # before recording a durable result, not merely the write response.
    with pathlib.Path(file).open("rb") as body:
        client.put_object(Bucket=BUCKET, Key=key, Body=body,
                          Metadata={"sha256": digest})
    stream = client.get_object(Bucket=BUCKET, Key=key)["Body"]
    checked = hashlib.sha256()
    count = 0
    try:
        while True:
            block = stream.read(1024 * 1024)
            if not block:
                break
            count += len(block)
            if count > size:
                raise RuntimeError("private_r2_readback_exceeded")
            checked.update(block)
    finally:
        stream.close()
    if count != size or checked.hexdigest() != digest:
        raise RuntimeError("private_r2_integrity_failed")

class PrivateCloudflareR2:
    """Authenticated Cloudflare API private bucket transport.

    No S3 credential, public domain, redirect, URL signing or customer access.
    The same dedicated release-run API token already protects MUSIC_DB.
    """
    def __init__(self, token, opener=OPENER):
        if (not token or os.environ.get("CLOUDFLARE_ACCOUNT_ID") != ACCOUNT):
            raise ValueError("dedicated_cloudflare_account_token_required")
        self.token = token
        self.opener = opener

    @staticmethod
    def object_url(bucket, key):
        if (bucket != BUCKET or
            not re.fullmatch(r"music-open-qa/(?:originals|reports)/[a-f0-9]{64}/?.*", key) or
            any(x in key for x in ("?", "#", "..", "\\\\"))):
            raise ValueError("untrusted_private_r2_object_key")
        return ("https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT +
                "/r2/buckets/" + BUCKET + "/objects/" +
                urllib.parse.quote(key, safe="/-._"))

    def put_object(self, Bucket, Key, Body, Metadata=None):
        original = Body.read(MAX_BYTES + 1)
        if len(original) > MAX_BYTES:
            raise ValueError("private_r2_api_byte_budget")
        req = urllib.request.Request(self.object_url(Bucket, Key), data=original,
            method="PUT", headers={
                "Authorization": "Bearer " + self.token,
                "Content-Type": "application/octet-stream",
                "Content-Length": str(len(original)),
                "User-Agent": AGENT})
        with self.opener.open(req, timeout=90) as response:
            if response.status not in (200, 201, 204):
                raise RuntimeError("private_r2_api_put_failed")
            response.read(1024)
        return {}

    def get_object(self, Bucket, Key):
        req = urllib.request.Request(self.object_url(Bucket, Key),
            headers={"Authorization": "Bearer " + self.token,
                     "User-Agent": AGENT, "Accept": "application/octet-stream"})
        stream = self.opener.open(req, timeout=90)
        if stream.status != 200:
            stream.close()
            raise RuntimeError("private_r2_api_get_failed")
        return {"Body": stream}


def make_r2():
    if os.environ.get("COVE_MUSIC_R2_BACKEND") == "cloudflare_api":
        return PrivateCloudflareR2(os.environ.get("CLOUDFLARE_API_TOKEN", ""))
    key = os.environ.get("COVE_MUSIC_R2_ACCESS_KEY_ID")
    secret = os.environ.get("COVE_MUSIC_R2_SECRET_ACCESS_KEY")
    if not key or not secret:
        raise ValueError("Private R2 S3 credentials required for opt-in QA")
    import boto3
    from botocore.config import Config
    return boto3.client(
        "s3", endpoint_url=f"https://{ACCOUNT}.r2.cloudflarestorage.com",
        aws_access_key_id=key, aws_secret_access_key=secret,
        region_name="auto", config=Config(signature_version="s3v4"))

def persist_durable_hold(token, row, reason):
    # Only permanently corroborated source/decoder conflicts create holds.
    # Transient upstream or transport errors remain retryable.
    at = dt.datetime.now(dt.timezone.utc).isoformat()
    d1("INSERT OR IGNORE INTO music_open_technical_qa"
       "(candidate_id,source_sha1,source_evidence_sha256,status,hold_reason,measured_at)"
       " SELECT id,source_sha1,evidence_sha256,'held',?,?"
       " FROM music_open_source_candidates"
       " WHERE id=? AND status='discovered' AND source_sha1=? AND evidence_sha256=?",
       [reason,at,row["id"],row["source_sha1"],row["evidence_sha256"]],token)
    found = d1("SELECT status,hold_reason FROM music_open_technical_qa WHERE candidate_id=?",
               [row["id"]],token)
    if found != [{"status":"held","hold_reason":reason}]:
        raise RuntimeError("held_source_receipt_not_durable")

def persist_measured(token, row, observed, measured, profile, audio_key, report_key, report_sha, checked):
    at = dt.datetime.now(dt.timezone.utc).isoformat()
    evidence = json.dumps({
        "originalSha1": row["source_sha1"], "originalSha256": observed["sha256"],
        "sourceRevision": checked["evidence"]["commonsRevision"],
        "sourceEvidenceSha256": checked["evidenceSha256"],
        "discoveryEvidenceSha256": row["evidence_sha256"],
        "acousticPolicy": "unreviewed", "rightsPolicy": "unreviewed",
        "fullDecode": measured, "dsp": profile,
    }, allow_nan=False, sort_keys=True, separators=(",", ":"))
    sql = (
        "INSERT OR IGNORE INTO music_open_technical_qa"
        "(candidate_id,source_sha1,source_sha256,original_bytes,source_evidence_sha256,"
        "audio_r2_key,report_r2_key,report_sha256,status,measured_at)"
        " SELECT c.id,c.source_sha1,?,?,?,?,?,?,'measured',?"
        " FROM music_open_source_candidates c WHERE c.id=? AND c.status='discovered'"
        " AND c.source_sha1=? AND c.evidence_sha256=?"
    )
    d1(sql, [observed["sha256"], observed["bytes"], row["evidence_sha256"],
             audio_key, report_key, report_sha, at,
             row["id"], row["source_sha1"], row["evidence_sha256"]], token)
    receipt = d1("SELECT status,source_sha1,source_sha256,report_sha256 FROM"
                 " music_open_technical_qa WHERE candidate_id=?", [row["id"]], token)
    if (len(receipt) != 1 or receipt[0] != {
            "status": "measured", "source_sha1": row["source_sha1"],
            "source_sha256": observed["sha256"], "report_sha256": report_sha}):
        raise RuntimeError("technical_receipt_not_durable_or_changed")
    return evidence

def prepare_one(row, temp, opener=OPENER, meter=MEASURE.measure, profiler=None):
    before = authoritative(row, opener)
    suffix = ".mp3" if row["source_file_url"].lower().endswith(".mp3") else ".ogg"
    path = pathlib.Path(temp) / ("original" + suffix)
    observed = download_original(before, path, opener)
    report = meter(path)
    if (report.get("sourceSha1") != row["source_sha1"] or
        report.get("sha256") != observed["sha256"] or
        report.get("bytes") != observed["bytes"] or
        report.get("decodedFully") is not True):
        raise ValueError("decoded_audio_not_exact_source")
    validate_full_audio_quality(report)
    profile = profiler(path) if profiler else None
    after = authoritative(row, opener)
    if before["evidenceSha256"] != after["evidenceSha256"]:
        raise ValueError("commons_revision_changed_during_qa")
    return before, observed, report, profile, path

def run(max_records=1, apply=False, profile_dsp=False, token=None, r2=None, limit_seconds=840):
    if not 1 <= max_records <= 2 or not 60 <= limit_seconds <= 900:
        raise ValueError("Strict isolated cohort/time cap required")
    if apply and os.environ.get("COVE_MUSIC_OPEN_QA_APPLY") != "1":
        raise ValueError("Technical QA private-R2 application explicitly disabled")
    token = token or os.environ.get("CLOUDFLARE_API_TOKEN", "")
    r2 = (r2 or make_r2()) if apply else None
    profiler = load("profile-audio.py", "audio_dsp_profile").analyze if profile_dsp else None
    started = time.monotonic()
    results = []
    for row in claim_read(token, max_records):
        if time.monotonic() - started >= limit_seconds:
            results.append({"id": row["id"], "status": "time_budget_exhausted"})
            break
        try:
            with tempfile.TemporaryDirectory(prefix="cove-open-audio-") as temp:
                checked, source, report, profile, audio = prepare_one(
                    row, temp, profiler=profiler)
                if not apply:
                    results.append({"id": row["id"], "status": "verified_dry_run",
                                    "sha256": source["sha256"],
                                    "rightsApproved": False, "quietApproved": False})
                    continue
                extension = pathlib.Path(audio).suffix
                audio_key = f"music-open-qa/originals/{source['sha256']}{extension}"
                details = {"candidateId": row["id"], "sourceSha1": row["source_sha1"],
                           "sourceSha256": source["sha256"], "bytes": source["bytes"],
                           "sourceRevision": checked["evidence"]["commonsRevision"],
                           "sourceEvidenceSha256": checked["evidenceSha256"],
                           "discoveryEvidenceSha256": row["evidence_sha256"],
                           "rightsApproved": False, "quietApproved": False,
                           "measurement": report, "dsp": profile}
                report_bytes = json.dumps(details, sort_keys=True, allow_nan=False,
                                          separators=(",", ":")).encode()
                digest = hashlib.sha256(report_bytes).hexdigest()
                report_file = pathlib.Path(temp) / "technical-report.json"
                report_file.write_bytes(report_bytes)
                report_key = f"music-open-qa/reports/{source['sha256']}/{digest}.json"
                r2_put_verified(r2, audio_key, audio, source["sha256"], source["bytes"])
                r2_put_verified(r2, report_key, report_file, digest, len(report_bytes))
                persist_measured(token, row, source, report, profile,
                                 audio_key, report_key, digest, checked)
                results.append({"id": row["id"], "status": "stored_private_technical_qa",
                                "sha256": source["sha256"],
                                "rightsApproved": False, "quietApproved": False})
        except (ValueError, RuntimeError, OSError, KeyError, TimeoutError) as error:
            reason = str(error)[:80]
            permanent = {
                "invalid_commons_file_identity", "authoritative_rights_or_original_hold",
                "original_or_license_changed", "unverifiable_discovery_evidence",
                "untrusted_original_url", "source_content_length_changed",
                "original_exceeds_byte_budget", "original_sha1_or_size_mismatch",
                "decoded_audio_not_exact_source", "full_audio_decode_incomplete",
                "full_audio_quality_not_eligible", "commons_revision_changed_during_qa",
            }
            if apply and reason in permanent:
                persist_durable_hold(token, row, reason)
            results.append({"id": row["id"], "status": "held_for_review",
                            "reason": reason})
    return {"scope": "detached_music_only", "customerPublished": False,
            "rightsApproved": False, "quietApproved": False, "results": results}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-recordings", type=int, default=1)
    parser.add_argument("--max-seconds", type=int, default=840)
    parser.add_argument("--profile-dsp", action="store_true")
    parser.add_argument("--apply-private", action="store_true")
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("music-open-qa.json"))
    args = parser.parse_args()
    report = run(args.max_recordings, args.apply_private, args.profile_dsp,
                 limit_seconds=args.max_seconds)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"scope": report["scope"],
                      "count": len(report["results"]),
                      "statuses": [r["status"] for r in report["results"]],
                      "customerPublished": False}))
    if any(x["status"] == "held_for_review" for x in report["results"]):
        raise SystemExit(2)

if __name__ == "__main__":
    main()

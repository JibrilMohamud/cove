#!/usr/bin/env python3
"""Drain a bounded number of already-approved Commons masters to private R2.

Cove's Worker remains authoritative for rights drift, source SHA-1, archived
evidence, FFmpeg report SHA-256, R2 checksum/size, and the ready transition.
This client never uploads or declares rights. A stored response counts only
after independent public HEAD + GET Range 206 verification.
"""
import argparse
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

ORIGIN = "https://cove-puce-theta.vercel.app"
IMPORT_PATH = "/api/fore/admin/soundtracks/import-next"
MEDIA_PREFIX = "/api/fore/soundtracks/recordings/"
MAX_ATTEMPTS = 12

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

OPENER = urllib.request.build_opener(NoRedirect)

def http(opener, method, path, token=None, headers=None, max_bytes=16384):
    if not path.startswith("/api/fore/") or "?" in path or "#" in path:
        raise ValueError("Unsafe Cove API path")
    h = {"User-Agent": "CoveSoundtrackR2Drain/1.0", **(headers or {})}
    if token is not None:
        h["Authorization"] = "Bearer " + token
    if method == "POST":
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(ORIGIN + path,
             method=method, data=b"{}" if method == "POST" else None, headers=h)
    # Never automatically replay a side-effecting import call: its response
    # could have been lost after the Worker stored a verified R2 original.
    with opener.open(req, timeout=115) as response:
        return response.status, dict(response.headers), response.read(max_bytes)

def verify_public_audio(recording_id, opener=OPENER):
    if not re.fullmatch(r"cm_[0-9]{1,15}", recording_id):
        raise ValueError("Worker returned a non-Commons recording identity")
    path = MEDIA_PREFIX + recording_id + "/audio"
    status, headers, _ = http(opener, "HEAD", path)
    length = int(headers.get("Content-Length", "0"))
    if status != 200 or not 1024 <= length <= 25 * 1024 * 1024:
        raise ValueError("New recording lacks a valid public HEAD response")
    if headers.get("Content-Type") not in ("audio/mpeg", "audio/ogg"):
        raise ValueError("New recording has an unexpected audio MIME")
    status, headers, data = http(opener, "GET", path,
                     headers={"Range":"bytes=0-1"}, max_bytes=4)
    if status != 206 or len(data) != 2 or headers.get("Content-Range") != "bytes 0-1/" + str(length):
        raise ValueError("New recording did not return correct HTTP Range audio")
    return {"id":recording_id,"bytes":length,"httpRange":206}

def drain(token, attempts=8, minutes=12, opener=OPENER, clock=time.monotonic, verify=verify_public_audio):
    if not token.startswith("fore_svc_"):
        raise ValueError("A purpose-scoped soundtrack review credential is required")
    if not 1 <= attempts <= MAX_ATTEMPTS or not 1 <= minutes <= 20:
        raise ValueError("Bounded recording and time budgets are required")
    start = clock()
    results = []
    for _ in range(attempts):
        if clock() - start >= minutes*60:
            results.append({"status":"time_budget_exhausted"})
            break
        try:
            status, _, payload = http(opener, "POST", IMPORT_PATH, token=token)
            if status != 200:
                raise RuntimeError("Unexpected import status")
            reply = json.loads(payload)
            if not isinstance(reply, dict):
                raise ValueError("Malformed Worker import response")
            if isinstance(reply.get("stored"), str):
                recording_id = reply["stored"]
                # Preserve conservative fail-closed behavior if public
                # routing has not propagated yet: never count unplayable audio.
                try:
                    proof = verify(recording_id, opener)
                    results.append({"status":"playable_verified",**proof})
                except (ValueError,urllib.error.URLError,OSError) as error:
                    results.append({"status":"verification_failed","id":recording_id,"type":type(error).__name__})
            elif isinstance(reply.get("skipped"), str):
                results.append({"status":"skipped","reason":reply["skipped"][:60]})
                break
            elif isinstance(reply.get("failed"), str) or isinstance(reply.get("invalidated"), str):
                results.append({"status":"import_held","id":reply.get("failed") or reply.get("invalidated"),
                                "reason":"Source, quality, or upstream validation failed"})
            elif isinstance(reply.get("canceled"), str):
                results.append({"status":"canceled","id":reply["canceled"]})
            else:
                raise ValueError("Unexpected Worker import response")
        except (RuntimeError,ValueError,OSError,urllib.error.URLError) as error:
            item={"status":"request_failed","type":type(error).__name__}
            if isinstance(error,urllib.error.HTTPError):
                item["httpStatus"]=error.code
            results.append(item)
            break
    return {"mode":"verified_commons_r2_import","attempts":len(results),
            "playableVerified":sum(r["status"]=="playable_verified" for r in results),
            "results":results}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--max-imports",type=int,default=8)
    p.add_argument("--max-minutes",type=int,default=12)
    p.add_argument("--output",type=pathlib.Path,required=True)
    args=p.parse_args()
    if not 1<=args.max_imports<=MAX_ATTEMPTS or not 1<=args.max_minutes<=20:
        p.error("Invalid bounded import limits")
    token=os.environ.get("COVE_SOUNDTRACK_REVIEW_TOKEN","")
    report=drain(token,args.max_imports,args.max_minutes)
    args.output.write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({"attempts":report["attempts"],
          "playableVerified":report["playableVerified"],
          "statuses":{label:sum(x["status"]==label for x in report["results"])
                      for label in set(x["status"] for x in report["results"])}},sort_keys=True))
    if any(r["status"] in ("verification_failed","import_held","request_failed")
           for r in report["results"]):
        return 2
    return 0

if __name__=="__main__":
    sys.exit(main())

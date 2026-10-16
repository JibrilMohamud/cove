#!/usr/bin/env python3
"""Verify real public R2-backed Cove music range playback, never just candidates.

A successful HTTP 206 with the exact audio path is a direct playable signal.
Exit nonzero for broken published recordings or a missing public API.
"""
import argparse
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://cove-puce-theta.vercel.app"
PATH = "/api/fore/soundtracks/recordings"

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

OPENER = urllib.request.build_opener(NoRedirect)

def fetch(url, method="GET", headers=None, opener=OPENER):
    request = urllib.request.Request(url, method=method,
        headers={"User-Agent":"CoveAudioPlaybackProbe/1.0", **(headers or {})})
    for attempt in range(4):
        try:
            with opener.open(request, timeout=25) as response:
                status = response.status
                response_headers = dict(response.headers)
                data = response.read(5_000_000 if method == "GET" else 0)
            return status, response_headers, data
        except urllib.error.HTTPError as error:
            if error.code not in (429,502,503,504) or attempt==3:
                raise
            time.sleep(min(2**attempt,4))

def run(base=BASE, limit=12, opener=OPENER):
    if base != BASE:
        raise ValueError("Monitoring origin must be the pinned Cove production hostname")
    status, _, body = fetch(base+PATH, opener=opener)
    if status != 200:
        raise RuntimeError("Public catalog HTTP status was not 200")
    payload = json.loads(body)
    rows = payload.get("recordings")
    if not isinstance(rows, list) or not isinstance(payload.get("count"), int) or payload["count"] != len(rows):
        raise ValueError("Invalid public catalog or inaccurate playable count")
    if len(rows) > 300:
        raise ValueError("The public soundtrack catalog exceeds the 300-recording response cap")
    checked = set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or row["id"] in checked:
            raise ValueError("Duplicate or invalid published recording")
        checked.add(row["id"])
        audio = row.get("audioUrl")
        if not isinstance(audio, str) or not audio.startswith(PATH+"/") or not audio.endswith("/audio") or \
                not re.fullmatch(r"[A-Za-z0-9_-]+", audio[len(PATH)+1:-6]):
            raise ValueError("Untrusted public audio path in recording metadata")
        if not row.get("attribution") or not row.get("licenseUrl"):
            raise ValueError("Published recording is missing mandatory rights attribution")
    # Choose records spread across the full list, not just the first page.
    indexes = sorted(set((i*len(rows))//min(len(rows),limit) for i in range(min(len(rows),limit))))
    failures = []
    for i in indexes:
        row = rows[i]
        address = base + row["audioUrl"]
        try:
            state, head, _ = fetch(address,"HEAD",opener=opener)
            length = int(head.get("Content-Length","0"))
            if state != 200 or length < 1024:
                raise ValueError("Unplayable HEAD response, missing stored media or too-small object")
            code, hdr, piece = fetch(address,headers={"Range":"bytes=0-1"},opener=opener)
            if code != 206 or len(piece) != 2 or hdr.get("Content-Range") != "bytes 0-1/"+str(length):
                raise ValueError("HTTP range playback response is invalid")
        except (ValueError,urllib.error.URLError,TimeoutError) as error:
            failures.append({"recording":row["id"],"error":type(error).__name__})
    return {"catalogCount":len(rows),"sampled":len(indexes),"sampleFailed":failures,
            "targetMin":150,"targetReached":len(rows)>=150,
            "targetMax":300}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",type=pathlib.Path,default=pathlib.Path("soundtrack-playback-receipt.json"))
    parser.add_argument("--strict-target",action="store_true")
    parser.add_argument("--sample",type=int,default=12)
    args=parser.parse_args()
    if not 1<=args.sample<=50:
        parser.error("Sample size must be 1–50")
    result=run(limit=args.sample)
    args.output.write_text(json.dumps(result,indent=2)+"\n")
    print(json.dumps(result))
    if result["sampleFailed"]: return 2
    if not result["targetReached"]:
        print("::warning::Cove's 150-recording minimum has not been achieved in real public playback.")
        return 3 if args.strict_target else 0
    return 0

if __name__=="__main__":
    sys.exit(main())

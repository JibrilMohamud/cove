#!/usr/bin/env python3
"""Tiny signed handoff of verified Commons *titles* into Cove's normal queue.

No indexed Openverse license ever authorizes a download. The backend obtains
fresh Commons file SHA/license data independently; only candidate intent
records are created, with no audio playback or automatic rights release.
"""
import argparse
import json
import os
import pathlib
import re
import urllib.request

ORIGIN = "https://cove-puce-theta.vercel.app"
API = ORIGIN + "/api/fore/admin/soundtracks/seed-commons"
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def candidates(payload,maximum=8):
    titles=[]
    seen=set()
    if payload.get("policy")!="cove-openverse-commons-discovery-v1":
        raise ValueError("Unknown candidate evidence policy")
    for item in payload.get("candidates",[]):
        title=item.get("sourceTitle")
        if (not isinstance(title,str) or not title.startswith("File:") or
            "/" in title or chr(92) in title or chr(10) in title or
            not re.fullmatch(r"File:.{4,240}\.(?:ogg|oga|mp3)",title,re.I)):
            continue
        if title in seen:
            continue
        seen.add(title)
        titles.append(title)
        if len(titles)>=maximum:
            break
    return titles

def rotate_titles(titles, limit=8, slot=None):
    """Rotate bounded source candidates between scheduled 3-hour campaigns.

    Do not repeatedly seed only the lexically earliest eight recordings.
    The authoritative review endpoint remains idempotent and fail-closed.
    """
    if not 1 <= limit <= 8 or len(titles)>32:
        raise ValueError("Unbounded curated Commons titles")
    if len(titles)<=limit:
        return titles
    import time
    slot=int(time.time()//10800) if slot is None else int(slot)
    start=(slot*limit)%len(titles)
    return [titles[(start+index)%len(titles)] for index in range(limit)]


def submit(titles,token,opener=None):
    if not titles:
        return dict(queued=0,skipped="no_candidates",customerPublished=False)
    if not token.startswith("fore_svc_") or len(token)<20:
        raise ValueError("Scoped soundtrack review identity required")
    if os.getenv("COVE_MUSIC_COMMONS_SEED_ENABLED")!="1":
        raise ValueError("Commons source-intent handoff not enabled")
    content=json.dumps({"titles":titles}).encode()
    request=urllib.request.Request(API,method="POST",data=content,
        headers={"Authorization":"Bearer "+token,"Content-Type":"application/json",
                 "User-Agent":"CoveLicensedMusicSeed/1.0 (https://cove-puce-theta.vercel.app/help)"})
    client=opener or urllib.request.build_opener(NoRedirect)
    with client.open(request,timeout=120) as response:
        if response.status!=200:
            raise RuntimeError("Cove source-intent verification rejected")
        result=json.loads(response.read(50000))
    if result.get("publicationAuthorized") is not False or result.get("customerAudioCopied") is not False:
        raise RuntimeError("Untrusted Commons seed response semantics")
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input",default="openverse-commons-candidates.json")
    parser.add_argument("--max-seed",type=int,default=8)
    parser.add_argument("--apply",action="store_true")
    args=parser.parse_args()
    if not 1<=args.max_seed<=8:
        parser.error("Only up to eight independently verified Commons files per handoff")
    source=json.loads(pathlib.Path(args.input).read_text())
    titles=rotate_titles(candidates(source,32),args.max_seed)
    if not args.apply:
        print(json.dumps({"dryRun":True,"candidates":len(titles),
                          "rightsApproved":False,"customerAudioCopied":False}))
        return
    response=submit(titles,os.environ.get("COVE_SOUNDTRACK_REVIEW_TOKEN",""))
    print(json.dumps({"queued":response.get("queued"),"existing":response.get("existing"),
                      "held":response.get("held"),"publicationAuthorized":False}))
if __name__=="__main__":
    main()

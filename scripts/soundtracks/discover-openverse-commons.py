#!/usr/bin/env python3
"""Openverse discovery → independent Commons-file evidence → detached D1 proposals.

Never scrape source sites, never download a recording, never create licenses,
approve recordings or publish customer audio. One Openverse search page/query.
All Writes (when opted in) target the named independent MUSIC_DB.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import time
import urllib.parse
import urllib.request
import uuid

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("commons_credit_audit", HERE / "commons-structured-credits.py")
credits = importlib.util.module_from_spec(spec)
spec.loader.exec_module(credits)
ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9"
MUSIC_DB = "fe9a9dd2-64b8-451c-a356-9ec71d9ee211"
API = "https://api.openverse.org/v1/audio/"
SEARCHES = ("solo piano classical", "instrumental harp", "quiet instrumental")
AGENT = "CoveOpenMusicDiscovery/1.0 (https://cove-puce-theta.vercel.app/help)"
ACCEPTED = ("CC0","CC-BY","CC-BY-SA")
MAX_BYTES = 25*1024*1024

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        return None

OPENER = urllib.request.build_opener(NoRedirect)

def read_json(url, opener=OPENER, size=500000):
    req = urllib.request.Request(url,headers={"User-Agent":AGENT,"Api-User-Agent":AGENT,
                                              "Accept":"application/json"})
    with opener.open(req, timeout=25) as response:
        if response.status != 200:
            raise ValueError("Remote source request rejected")
        payload=response.read(size+1)
        if len(payload)>size:
            raise ValueError("Unbounded remote API response")
    return json.loads(payload)

def commons_title(record):
    # Only verified Wikimedia-hosted Commons original file page links. Never
    # accept Openverse's indexed license or media URL as a licensing decision.
    url = urllib.parse.urlsplit(str(record.get("foreign_landing_url") or ""))
    if url.scheme!="https" or url.hostname!="commons.wikimedia.org" or url.port or url.username or url.password or url.query or url.fragment:
        return None
    title = urllib.parse.unquote(url.path.removeprefix("/wiki/")).replace("_"," ")
    if "/" in title or chr(92) in title or chr(10) in title or not re.fullmatch(r"File:.{4,240}\\.(?:ogg|oga|mp3)",title,re.I):
        return None
    return title

def exact_candidate(record, page):
    title = commons_title(record)
    if not title or page.get("title") != title or not isinstance(page.get("pageid"),int):
        return None
    info = (page.get("imageinfo") or [{}])[0]
    size=info.get("size")
    sha=str(info.get("sha1") or "").lower()
    if not isinstance(size,int) or not 128<=size<=MAX_BYTES or not re.fullmatch("[a-f0-9]{40}",sha):
        return None
    if info.get("mime") not in ("audio/ogg","application/ogg","audio/mpeg"):
        return None
    direct=urllib.parse.urlsplit(str(info.get("url") or ""))
    if (direct.scheme!="https" or direct.hostname!="upload.wikimedia.org" or
        direct.port or direct.query or direct.fragment or direct.username or direct.password or
        not re.fullmatch(r"/wikipedia/commons/[^\s?]+\.(?:ogg|oga|mp3)",direct.path,re.I)):
        return None
    meta=info.get("extmetadata") or {}
    declared=credits.plain(meta.get("LicenseShortName",{}).get("value")).casefold()
    link=str(meta.get("LicenseUrl",{}).get("value") or "").rstrip("/")+"/"
    license_code=None
    if declared in ("cc0","cc0 1.0") and link==credits.LICENSE["CC0"]:
        license_code="CC0"
    for short,tag in (("CC-BY","cc by "),("CC-BY-SA","cc by-sa ")):
        if (declared.startswith(tag) and
            re.fullmatch(r"[234](?:\.0|\.5)",declared[len(tag):]) and
            link==credits.LICENSE[short]+declared[len(tag):]+"/"):
            license_code=short
    if license_code is None:
        return None
    wiki=str((page.get("revisions") or [{}])[0].get("slots",{}).get("main",{}).get("content") or "")
    # Source conflict is not a soft classifier score. No automatic clearance.
    joined=wiki+" "+str(info.get("metadata") or "")+" "+credits.plain(meta.get("ImageDescription",{}).get("value"))
    if credits.BLOCK.search(joined):
        return None
    evidence={
        "policy":"cove-openverse-commons-discovery-v1",
        "discovery":"openverse",
        "openverseId":str(record.get("id") or "")[:80],
        "sourceTitle":title,
        "commonsRevision":(page.get("revisions") or [{}])[0].get("revid"),
        "commonsRevisionTimestamp":(page.get("revisions") or [{}])[0].get("timestamp"),
        "sourceSha1":sha,"sourceBytes":size,
        "fileLicenseCode":license_code,"fileLicenseUrl":link,
        "rawArtist":credits.plain(meta.get("Artist",{}).get("value"))[:200],
        "rawCredit":credits.plain(meta.get("Credit",{}).get("value"))[:240],
        "rightsStatus":"DISCOVERY_ONLY_NEEDS_RECORDING_VERIFICATION",
    }
    compact=json.dumps(evidence,sort_keys=True,ensure_ascii=False,separators=(",",":"))
    return {
        "id":"cm_"+str(page["pageid"]),
        "discoveryProvider":"openverse",
        "sourceTitle":title,
        "sourcePageUrl":"https://commons.wikimedia.org/wiki/"+urllib.parse.quote(title.replace(" ","_"),safe=":_()'"),
        "sourceFileUrl":direct.geturl(),
        "sourceSha1":sha,
        "sizeBytes":size,
        "licenseCode":license_code,
        "licenseUrl":link,
        "evidence":evidence,
        "evidenceSha256":hashlib.sha256(compact.encode()).hexdigest(),
    }

def verified_commons_title(title, opener=OPENER):
    query=urllib.parse.urlencode({
        "action":"query","format":"json","formatversion":"2","maxlag":"5",
        "titles":title,"prop":"imageinfo|revisions",
        "iiprop":"url|sha1|size|mime|extmetadata|metadata",
        "rvprop":"ids|timestamp|content","rvslots":"main"
    })
    pages=read_json(credits.COMMONS_API+"?"+query,opener=opener).get("query",{}).get("pages",[])
    return pages[0] if isinstance(pages,list) and len(pages)==1 else None

def discover(queries=2, max_verifications=12, opener=OPENER, pause=time.sleep):
    items=[]
    seen=set()
    started=time.monotonic()
    searched=0
    verified=0
    for query in SEARCHES[:queries]:
        if verified>=max_verifications:
            break
        params=urllib.parse.urlencode({"q":query,"category":"music","license":"by,by-sa,cc0",
                                        "page":1,"page_size":20,"mature":"false"})
        response=read_json(API+"?"+params,opener)
        searched+=1
        for indexed in response.get("results",[]):
            if verified>=max_verifications:
                break
            title=commons_title(indexed)
            if not title or title in seen:
                continue
            seen.add(title)
            verified+=1
            try:
                page=verified_commons_title(title,opener)
                result=exact_candidate(indexed,page or {})
                if result:
                    items.append(result)
            except (OSError,ValueError,KeyError,TypeError):
                pass
            pause(.5)
    return {"policy":"cove-openverse-commons-discovery-v1","searches":searched,
            "verified":verified,"candidates":items,
            "processingMs":min(1800000,int((time.monotonic()-started)*1000))}

def record_isolated(summary, token, opener=OPENER):
    if os.environ.get("COVE_MUSIC_OPEN_DISCOVERY_ENABLED")!="1":
        raise ValueError("Independent discovery store not enabled")
    if os.environ.get("CLOUDFLARE_ACCOUNT_ID")!=ACCOUNT or not token:
        raise ValueError("No approved isolated D1 writer identity")
    endpoint=f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{MUSIC_DB}/query"
    at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
    def sql(command,params):
        data=json.dumps({"sql":command,"params":[str(v) for v in params]}).encode()
        req=urllib.request.Request(endpoint,data=data,method="POST",headers={
            "Authorization":"Bearer "+token,"Content-Type":"application/json",
            "User-Agent":AGENT})
        with opener.open(req,timeout=30) as response:
            if response.status != 200:
                raise RuntimeError("Isolated source discovery persistence rejected")
            result=json.loads(response.read(500000))
        if not result.get("success") or not all(x.get("success") for x in result.get("result",[])):
            raise RuntimeError("Isolated source discovery persistence failed")
    for candidate in summary["candidates"]:
        raw=json.dumps(candidate["evidence"],sort_keys=True,ensure_ascii=False,separators=(",",":"))
        sql("INSERT INTO music_open_source_candidates"
            "(id,discovery_provider,source_page_url,source_file_url,source_title,source_sha1,size_bytes,license_code,license_url,evidence_json,evidence_sha256,status,discovered_at,last_seen_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,'discovered',?,?)"
            " ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at,"
            " status=CASE WHEN music_open_source_candidates.source_sha1<>excluded.source_sha1"
            " OR music_open_source_candidates.license_url<>excluded.license_url"
            " OR music_open_source_candidates.source_file_url<>excluded.source_file_url"
            " THEN 'held' ELSE music_open_source_candidates.status END,"
            " hold_reason=CASE WHEN music_open_source_candidates.source_sha1<>excluded.source_sha1"
            " OR music_open_source_candidates.license_url<>excluded.license_url"
            " OR music_open_source_candidates.source_file_url<>excluded.source_file_url"
            " THEN 'original_changed' ELSE music_open_source_candidates.hold_reason END",
            [candidate["id"],candidate["discoveryProvider"],candidate["sourcePageUrl"],
             candidate["sourceFileUrl"],candidate["sourceTitle"],candidate["sourceSha1"],
             candidate["sizeBytes"],candidate["licenseCode"],candidate["licenseUrl"],
             raw,candidate["evidenceSha256"],at,at])
    sql("INSERT INTO music_open_discovery_runs(run_id,provider,searches,verified,discovered,processing_ms,recorded_at)"
        " VALUES(?,'openverse',?,?,?,?,?)",
        [str(uuid.uuid4()),summary["searches"],summary["verified"],
         len(summary["candidates"]),summary["processingMs"],at])
    return len(summary["candidates"])

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--queries",type=int,default=2)
    p.add_argument("--max-verifications",type=int,default=12)
    p.add_argument("--output",default="openverse-commons-candidates.json")
    p.add_argument("--apply-isolated",action="store_true")
    args=p.parse_args()
    if not 1<=args.queries<=3 or not 1<=args.max_verifications<=20:
        p.error("Rate-bounded one-page Openverse/Commons discovery required")
    result=discover(args.queries,args.max_verifications)
    pathlib.Path(args.output).write_text(json.dumps(result,indent=2,ensure_ascii=False)+"\n")
    if args.apply_isolated:
        record_isolated(result,os.environ.get("CLOUDFLARE_API_TOKEN",""))
    print(json.dumps({"searched":result["searches"],"checkedOriginalPages":result["verified"],
                      "candidates":len(result["candidates"]),"storedIsolated":args.apply_isolated,
                      "customerPublished":False,"elapsedMs":result["processingMs"]}))
if __name__=="__main__":
    main()

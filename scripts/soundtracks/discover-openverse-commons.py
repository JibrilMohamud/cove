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
# Rotate distinct music queries; one permitted API page per query.
# Do not enumerate Openverse's search index or bypass its pagination limits.
SEARCHES = (
    "piano", "harp", "nocturne",
    "guitar", "baroque", "flute",
    "cello", "chopin", "violin",
    "harpsichord", "oboe", "lute",
    "satie", "quartet", "organ",
    "instrumental", "waltz", "clarinet",
    "dulcimer", "sonata", "renaissance",
    "recorder", "romantic", "chamber",
)
COMMONS_CATEGORIES = (
    "Audio files of classical music for piano",
    "Audio files of Baroque period classical music",
    "Audio files of Classical period classical music",
    "Audio files of Romantic period classical music",
    "Audio files of harp music",
    "Audio files of cello music",
    "Audio files of harpsichord music",
    "Audio files of classical music for violin",
    "Audio files of guitar music",
    "Audio files of adagio (music)",
    "Audio files of music by Johann Sebastian Bach",
    "Audio files of piano music by Joseph Haydn",
)
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
    if "/" in title or chr(92) in title or chr(10) in title or not re.fullmatch(r"File:.{4,240}\.(?:ogg|oga|mp3)",title,re.I):
        return None
    return title

def exact_candidate(record, page, provider="openverse", category=None, diagnostics=None):
    def reject(reason):
        if diagnostics is not None:
            diagnostics[reason]=diagnostics.get(reason,0)+1
        return None
    if provider not in ("openverse", "commons"):
        raise ValueError("Unsupported original discovery provider")
    title = commons_title(record)
    if not title or page.get("title") != title or not isinstance(page.get("pageid"),int):
        return reject("page_identity")
    info = (page.get("imageinfo") or [{}])[0]
    size=info.get("size")
    sha=str(info.get("sha1") or "").lower()
    if not isinstance(size,int) or not 128<=size<=MAX_BYTES or not re.fullmatch("[a-f0-9]{40}",sha):
        return reject("missing_or_oversized_original")
    if info.get("mime") not in ("audio/ogg","application/ogg","audio/mpeg"):
        return reject("unsupported_audio_mime")
    direct=urllib.parse.urlsplit(str(info.get("url") or ""))
    if direct.scheme!="https" or direct.hostname!="upload.wikimedia.org":
        return reject("original_host_or_scheme")
    if direct.port or direct.username or direct.password:
        return reject("original_url_credentials_or_port")
    if direct.fragment:
        return reject("original_url_fragment")
    if direct.query:
        # Commons adds documented analytics tracking to original URLs.
        # Match the existing authoritative JavaScript sourceFileUrl policy:
        # allow only UTM keys, never carry them to R2 or audio downloads.
        if len(direct.query)>512:
            return reject("original_unbounded_query")
        try:
            tracking=urllib.parse.parse_qsl(
                direct.query,keep_blank_values=True,
                strict_parsing=True,max_num_fields=10)
        except ValueError:
            return reject("original_invalid_query")
        if not tracking or any(
                not re.fullmatch(r"utm_[a-z0-9_]+",key,re.I)
                for key,_ in tracking):
            return reject("original_untrusted_query")
        direct=direct._replace(query="")
    if not re.fullmatch(r"/wikipedia/commons/[^\s?]+\.(?:ogg|oga|mp3)",direct.path,re.I):
        return reject("original_filename_path")
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
        return reject("license_not_strictly_eligible")
    wiki=str((page.get("revisions") or [{}])[0].get("slots",{}).get("main",{}).get("content") or "")
    # Source conflict is not a soft classifier score. No automatic clearance.
    joined=wiki+" "+str(info.get("metadata") or "")+" "+credits.plain(meta.get("ImageDescription",{}).get("value"))
    if credits.BLOCK.search(joined):
        return reject("contradictory_source_rights")
    evidence={
        "policy":"cove-openverse-commons-discovery-v1",
        "discovery":provider,
        "discoveryCategory":category,
        "openverseId":str(record.get("id") or "")[:80] if provider=="openverse" else None,
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
        "discoveryProvider":provider,
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

def commons_category_candidates(categories=2, max_verifications=16, opener=OPENER, pause=time.sleep):
    """One rate-bounded generator page per Commons category, no scraping.

    The generator supplies the actual Commons revision, imageinfo, license
    and checksum in the same authoritative API response. No audio bytes
    are fetched. A Commons CC label is only discovery evidence.
    """
    if not 0 <= categories <= 3 or not 0 <= max_verifications <= 32:
        raise ValueError("Commons discovery quota exceeded")
    started=int(time.time() // 86400) % len(COMMONS_CATEGORIES)
    found=[]
    checked=0
    held=0
    rejection_reasons={}
    category_queries=0
    for offset in range(categories):
        if checked>=max_verifications:
            break
        category=COMMONS_CATEGORIES[(started+offset)%len(COMMONS_CATEGORIES)]
        args=urllib.parse.urlencode({
            "action":"query","format":"json","formatversion":"2","maxlag":"5",
            "generator":"categorymembers","gcmtitle":"Category:"+category,
            "gcmtype":"file","gcmlimit":"24",
            "prop":"imageinfo|revisions",
            "iiprop":"url|sha1|size|mime|extmetadata|metadata",
            "rvprop":"ids|timestamp|content","rvslots":"main",
        })
        payload=read_json(credits.COMMONS_API+"?"+args,opener=opener,size=1200000)
        category_queries+=1
        if payload.get("error"):
            raise ValueError("Commons authoritative category query failed")
        pages=payload.get("query",{}).get("pages",[])
        if not isinstance(pages,list):
            raise ValueError("Invalid Commons API category result")
        for page in pages:
            if checked>=max_verifications:
                break
            title=page.get("title")
            if not isinstance(title,str) or not title.startswith("File:"):
                continue
            identity={"foreign_landing_url":"https://commons.wikimedia.org/wiki/"+
                      urllib.parse.quote(title.replace(" ","_"),safe=":_()'")}
            # Audio extensions must be supported before spending the bounded
            # original-verification budget. A category contains FLAC/WAV,
            # PDFs and score files that this importer cannot quality-check.
            if not commons_title(identity):
                continue
            checked+=1
            result=exact_candidate(identity,page,"commons",category,rejection_reasons)
            if result:
                found.append(result)
            else:
                held+=1
        pause(.5)
    return {"candidates":found,"verified":checked,"searches":category_queries,
            "held":held,"holdReasons":rejection_reasons}


def discover(queries=2, max_verifications=12, opener=OPENER, pause=time.sleep, commons_categories=2):
    items=[]
    seen=set()
    started=time.monotonic()
    searched=0
    verified=0
    indexed_results=0
    rejected_non_commons=0
    held_after_commons_check=0
    if not 0 <= commons_categories <= 3:
        raise ValueError("Unbounded Commons category count")
    start_search = int(time.time() // 86400) % len(SEARCHES)
    for shift in range(queries):
        query = SEARCHES[(start_search + shift) % len(SEARCHES)]
        if verified>=max_verifications:
            break
        # Openverse aggregates many audio repositories. Source targeting
        # dramatically reduces wasted first-page results and ensures this
        # fast lane never queries third-party original hosts.
        params=urllib.parse.urlencode({"q":query,"source":"wikimedia_audio",
                                        "category":"music","license":"by,by-sa,cc0",
                                        "page":1,"page_size":20,"mature":"false"})
        response=read_json(API+"?"+params,opener)
        searched+=1
        results=response.get("results",[])
        if not isinstance(results,list):
            raise ValueError("Openverse results must be a list")
        indexed_results += len(results)
        for indexed in results:
            if verified>=max_verifications:
                break
            title=commons_title(indexed)
            if not title:
                rejected_non_commons+=1
                continue
            if title in seen:
                continue
            seen.add(title)
            verified+=1
            try:
                page=verified_commons_title(title,opener)
                result=exact_candidate(indexed,page or {})
                if result:
                    items.append(result)
                else:
                    held_after_commons_check+=1
            except (OSError,ValueError,KeyError,TypeError):
                held_after_commons_check+=1
            pause(.5)
    from_commons=commons_category_candidates(
        commons_categories,max(0,min(32-verified,max_verifications-verified)),
        opener=opener,pause=pause) if commons_categories else {
            "candidates":[],"verified":0,"searches":0,"held":0,"holdReasons":{}}
    unique={item["id"]:item for item in items}
    for candidate in from_commons["candidates"]:
        unique.setdefault(candidate["id"],candidate)
    return {"policy":"cove-openverse-commons-discovery-v1",
            "searches":searched+from_commons["searches"],
            "openverseSearches":searched,
            "commonsCategoryQueries":from_commons["searches"],
            "openverseVerified":verified,
            "commonsVerified":from_commons["verified"],
            "verified":verified+from_commons["verified"],
            "indexedResults":indexed_results,
            "nonCommonsResults":rejected_non_commons,
            "commonsHoldReasons":from_commons["holdReasons"],
            "heldAfterCommonsVerification":held_after_commons_check+from_commons["held"],
            "candidates":list(unique.values()),
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
    for provider,searches,verified in (
        ("openverse",summary.get("openverseSearches",summary["searches"]),
         summary.get("openverseVerified",summary["verified"])),
        ("commons",summary.get("commonsCategoryQueries",0),
         summary.get("commonsVerified",0)),
    ):
        if searches:
            discovered=sum(x["discoveryProvider"]==provider for x in summary["candidates"])
            sql("INSERT INTO music_open_discovery_runs(run_id,provider,searches,verified,discovered,processing_ms,recorded_at)"
                " VALUES(?,?,?,?,?,?,?)",
                [str(uuid.uuid4()),provider,searches,verified,
                 discovered,summary["processingMs"],at])
    return len(summary["candidates"])

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--queries",type=int,default=2)
    p.add_argument("--max-verifications",type=int,default=20)
    p.add_argument("--commons-categories",type=int,default=2)
    p.add_argument("--output",default="openverse-commons-candidates.json")
    p.add_argument("--apply-isolated",action="store_true")
    args=p.parse_args()
    if not 1<=args.queries<=3 or not 0<=args.commons_categories<=3 or not 1<=args.max_verifications<=32:
        p.error("Rate-bounded one-page Openverse/Commons discovery required")
    result=discover(args.queries,args.max_verifications,commons_categories=args.commons_categories)
    pathlib.Path(args.output).write_text(json.dumps(result,indent=2,ensure_ascii=False)+"\n")
    if args.apply_isolated:
        record_isolated(result,os.environ.get("CLOUDFLARE_API_TOKEN",""))
    if result["verified"] == 0:
        print("::warning::Openverse returned no matching Commons originals; no rights decisions made")
    print(json.dumps({"searched":result["searches"],"indexedResults":result["indexedResults"],
                      "nonCommonsResults":result["nonCommonsResults"],
                      "checkedOriginalPages":result["verified"],
                      "commonsCategoryQueries":result["commonsCategoryQueries"],
                      "commonsOriginalsChecked":result["commonsVerified"],
                      "commonsHoldReasons":result["commonsHoldReasons"],
                      "heldAfterCommonsVerification":result["heldAfterCommonsVerification"],
                      "candidates":len(result["candidates"]),"storedIsolated":args.apply_isolated,
                      "customerPublished":False,"elapsedMs":result["processingMs"]}))
if __name__=="__main__":
    main()

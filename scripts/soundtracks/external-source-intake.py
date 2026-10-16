#!/usr/bin/env python3
"""Fail-closed, file-based FMA/Musopen intake: rights and media QA evidence only.

No FMA/Musopen scraping or automated remote downloading. The source's general
license reputation is NOT permission to copy a specific master, nor permission
to use its website as an automated bulk-feed. Output never authorizes serving.
"""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import pathlib
import re
import sys
from urllib.parse import urlsplit

MAX_BYTES = 25 * 1024 * 1024
MAX_TRACKS = 300
PROVIDERS = {"fma": "freemusicarchive.org", "musopen": "musopen.org"}
CC = {
    "CC0": r"https://creativecommons\.org/publicdomain/zero/1\.0/?",
    "CC-BY": r"https://creativecommons\.org/licenses/by/(?:2\.0|2\.5|3\.0|4\.0)/?",
    "CC-BY-SA": r"https://creativecommons\.org/licenses/by-sa/(?:2\.0|2\.5|3\.0|4\.0)/?",
    "PD": r"https://musopen\.org/faq/?"
}
LAYERS = ("composition", "arrangement", "lyrics", "performance", "master")


def secure_url(value, host=None):
    if not isinstance(value, str) or len(value) > 1000:
        return False
    try:
        u = urlsplit(value)
        return bool(u.scheme == "https" and u.hostname and not u.port and
                    not u.username and not u.password and not u.fragment and
                    (host is None or u.hostname == host))
    except ValueError:
        return False


def validate(r):
    if not isinstance(r, dict) or r.get("provider") not in PROVIDERS:
        raise ValueError("One individually identified fma/musopen recording required")
    page = r.get("sourcePageUrl")
    if not secure_url(page, PROVIDERS[r["provider"]]) or not urlsplit(page).path.startswith("/music/"):
        raise ValueError("Individual HTTPS source page is required")
    for name in ("id", "title", "composer", "performer", "attributionText"):
        if not isinstance(r.get(name), str) or not 3 <= len(r[name].strip()) <= 1000:
            raise ValueError(name + " is missing")
    if not re.fullmatch(r"[a-zA-Z0-9_-]{4,100}", r["id"]):
        raise ValueError("Invalid recording identifier")
    if re.search(r"(?i)\b(?:unknown|unverified|various artists)\b", r["performer"]):
        raise ValueError("Unverified performer")
    code = r.get("licenseCode")
    if code not in CC or not re.fullmatch(CC[code], r.get("licenseUrl", "")):
        raise ValueError("Individual commercial CC license or Musopen US public-domain claim required")
    if code == "PD" and r["provider"] != "musopen":
        raise ValueError("Musopen-only public-domain reliance; FMA PD needs a source-specific gate")
    rights = r.get("rightsEvidence")
    if not isinstance(rights, dict):
        raise ValueError("Full rights dossier required")
    for layer in LAYERS:
        evidence = rights.get(layer)
        if not isinstance(evidence, dict) or len(str(evidence.get("basis", "")).strip()) < 40:
            raise ValueError(layer + " rationale missing")
        links = evidence.get("evidenceUrls")
        if not isinstance(links, list) or not 1 <= len(links) <= 12 or not all(secure_url(x) for x in links):
            raise ValueError(layer + " source evidence URLs missing")
    if r.get("unresolved") not in (None, []):
        raise ValueError("Unresolved rights questions")
    grant = r.get("providerAccessGrant")
    acquisition = r.get("acquisitionEvidence")
    if grant is not None:
        if (not isinstance(grant, dict) or not secure_url(grant.get("evidenceUrl")) or
                len(str(grant.get("grantingParty", "")).strip()) < 3 or
                "commercial" not in str(grant.get("scope", "")).lower() or
                "download" not in str(grant.get("scope", "")).lower() or
                "redistribut" not in str(grant.get("scope", "")).lower()):
            raise ValueError("Claimed separate commercial delivery grant is incomplete")
    if acquisition is not None:
        if (not isinstance(acquisition, dict) or acquisition.get("method") != "manual_download" or
                acquisition.get("sourcePageUrl") != page or
                acquisition.get("noAutomatedProviderAccess") is not True or
                acquisition.get("originalUnmodified") is not True or
                not isinstance(acquisition.get("acquiredAt"), str) or
                not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)", acquisition["acquiredAt"])):
            raise ValueError("Exact-track manual acquisition evidence is missing or malformed")
    if grant is None and not (r["provider"] == "fma" and code != "PD" and acquisition is not None):
        raise ValueError("A source-specific delivery grant or lawful manual FMA acquisition is required")
    if r.get("compositionRightsConfirmed") is not True or r.get("masterRedistributionConfirmed") is not True:
        raise ValueError("Composition and exact-master rights not confirmed")
    if r.get("territories") != ["US"]:
        raise ValueError("Intake only supports US rights assessment")
    if not re.fullmatch(r"[a-f0-9]{40}", str(r.get("sha1", ""))) or not re.fullmatch(r"[a-f0-9]{64}", str(r.get("sha256", ""))):
        raise ValueError("Exact original SHA-1 and SHA-256 are required")
    if type(r.get("bytes")) is not int or not 0 < r["bytes"] <= MAX_BYTES:
        raise ValueError("Original exceeds Cove's 25 MiB audio limit")
    if r.get("mime") not in ("audio/ogg", "audio/mpeg"):
        raise ValueError("Unsupported MIME")
    if not isinstance(r.get("file"), str) or not re.fullmatch(r"[a-zA-Z0-9_.-]{3,160}\.(?:ogg|oga|mp3)", r["file"]):
        raise ValueError("Unsafe or missing flat audio filename")
    if (r["mime"] == "audio/mpeg" and not r["file"].lower().endswith(".mp3")) or (
            r["mime"] == "audio/ogg" and not r["file"].lower().endswith((".ogg", ".oga"))):
        raise ValueError("File extension and MIME disagree")
    if r.get("period") not in ("medieval", "renaissance", "baroque", "classical", "romantic", "modern", "contemporary"):
        raise ValueError("Period missing")
    for field in ("moods", "instruments"):
        if not isinstance(r.get(field), list) or not r[field] or not all(isinstance(x, str) and len(x) >= 2 for x in r[field]):
            raise ValueError(field + " missing")
    if not isinstance(r.get("energy"), (int, float)) or isinstance(r["energy"], bool) or not 0 <= r["energy"] <= 1:
        raise ValueError("Energy missing")
    if type(r.get("hasVocals")) is not bool:
        raise ValueError("Vocal tag missing")
    return r


def hashes(path):
    sha1, sha256 = hashlib.sha1(), hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            size += len(chunk)
            if size > MAX_BYTES:
                raise ValueError("Audio file too large")
            sha1.update(chunk)
            sha256.update(chunk)
    return size, sha1.hexdigest(), sha256.hexdigest()


def measure(path):
    spec = importlib.util.spec_from_file_location("cove_audio_measure", pathlib.Path(__file__).with_name("measure-audio.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.measure(path)


def qa_passes(q):
    return (q.get("decodedFully") is True and -40 <= q.get("integratedLufs", 99) <= -8 and
            q.get("truePeakDbfs", 99) <= 0 and q.get("silenceRatio", 99) <= .25 and
            q.get("clippedSampleRatio", 99) <= .001 and 0 < q.get("durationSeconds", 0) <= 14400 and
            q.get("channels") in (1, 2) and 8000 <= q.get("sampleRate", 0) <= 192000)


def evaluate(manifest, audio_dir, limit=MAX_TRACKS, run_qa=True):
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("recordings"), list):
        raise ValueError("Schema v1 recordings array required")
    rows = manifest["recordings"]
    if not 1 <= limit <= MAX_TRACKS or len(rows) > limit:
        raise ValueError("Batch limit exceeded (max 300)")
    root = audio_dir.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Audio directory missing")
    receipts = []
    ids = set()
    pages = set()
    for candidate in rows:
        entry = {"id":str(candidate.get("id", "?")) if isinstance(candidate, dict) else "?",
                 "status":"rejected"}
        try:
            r = validate(candidate)
            if r["id"] in ids or r["sourcePageUrl"] in pages:
                raise ValueError("Duplicate recording or source page")
            ids.add(r["id"])
            pages.add(r["sourcePageUrl"])
            path = audio_dir / r["file"]
            if path.is_symlink() or not path.is_file() or path.resolve(strict=True).parent != root:
                raise ValueError("Audio path must be a regular file in the supplied directory")
            if hashes(path) != (r["bytes"], r["sha1"], r["sha256"]):
                raise ValueError("Original source hash or byte count mismatch")
            if run_qa:
                q = measure(path)
                if (q["bytes"], q["sourceSha1"], q["sha256"]) != (r["bytes"], r["sha1"], r["sha256"]) or not qa_passes(q):
                    raise ValueError("Audio fails exact-source measurement/quality gates")
                entry["quality"] = q
            entry.update(status="qa_verified_staged" if run_qa else "rights_evidence_staged",
                         source={k:r[k] for k in ("provider","sourcePageUrl","licenseCode","licenseUrl","sha1","sha256","bytes","file")},
                         rightsEvidence=r["rightsEvidence"],providerAccessGrant=r.get("providerAccessGrant"),
                         acquisitionEvidence=r.get("acquisitionEvidence"),
                         attributionText=r["attributionText"])
        except (ValueError, OSError, KeyError) as error:
            entry["reason"] = str(error)[:300]
        receipts.append(entry)
    return {"schemaVersion":1,"generatedAt":dt.datetime.now(dt.timezone.utc).isoformat(),
            "publishable":False,
            "notice":"No release: an authorized backend reviewer must recheck and explicitly approve any candidate before R2 publication.",
            "results":receipts,
            "summary":{"staged":sum(x["status"].endswith("_staged") for x in receipts),
                       "rejected":sum(x["status"]=="rejected" for x in receipts)}}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--manifest", type=pathlib.Path, required=True)
    p.add_argument("--audio-dir", type=pathlib.Path, required=True)
    p.add_argument("--output", type=pathlib.Path, required=True)
    p.add_argument("--rights-only", action="store_true")
    a = p.parse_args()
    result = evaluate(json.loads(a.manifest.read_text()), a.audio_dir, run_qa=not a.rights_only)
    a.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result["summary"]))
    return int(result["summary"]["rejected"] > 0)


if __name__ == "__main__":
    sys.exit(main())

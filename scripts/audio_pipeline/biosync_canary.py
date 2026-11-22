"""One-shot, idempotent, independently verified BioSync production canary.

GitHub Actions has enough ephemeral disk to index Cove's pinned EPUB.
Read-only D1 discovery and R2 map upload use separate narrow principals.
The verified timing pointer is committed only by an authorized private owner.
This migration is staging-only until a protected cutover is certified.
Do not publish invented word timestamps or confidence values.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from .align import align
from .epub_index import build

ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9"
# Never read/write the production D1 or R2 during QA owner enrollment.
QA_DATABASES = {"5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
                "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"}
DATABASE = os.environ.get("COVE_BIOSYNC_QA_DATABASE_ID", "")
BUCKET = os.environ.get("COVE_BIOSYNC_QA_BUCKET", "")
EDITION = "pg-19504"
TRACK = "02"
JOB = "align-pg-19504-02-7fb5b7e4c4a400b1"
BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}"


def authorized_request(method: str, endpoint: str, payload: bytes | None = None, *, json_body=False) -> bytes:
    endpoint_parts = urllib.parse.urlsplit(endpoint)
    if endpoint_parts.scheme != "https" or endpoint_parts.netloc != "api.cloudflare.com":
        raise RuntimeError("BioSync Cloudflare endpoint host is not authorized")
    path = endpoint_parts.path
    if path.startswith(f"/client/v4/accounts/{ACCOUNT}/d1/"):
        token = os.environ["COVE_BIOSYNC_D1_READ_TOKEN"]
        if method != "POST" or not path.endswith("/query"):
            raise RuntimeError("BioSync D1 transport is strictly read-only")
    elif path.startswith(f"/client/v4/accounts/{ACCOUNT}/r2/"):
        token = os.environ["COVE_BIOSYNC_R2_TOKEN"]
        if method not in ("GET", "PUT"):
            raise RuntimeError("Unsupported BioSync R2 operation")
    else:
        raise RuntimeError("BioSync Cloudflare endpoint is not allowlisted")
    headers = {"Authorization": f"Bearer {token}"}
    if json_body:
        headers["Content-Type"] = "application/json"
    elif payload is not None:
        headers["Content-Type"] = "application/octet-stream"
    request = urllib.request.Request(endpoint, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Cloudflare {method} {urllib.parse.urlparse(endpoint).path} returned HTTP {error.code}") from None


def query(sql: str, params: list[object] | None = None) -> list[dict]:
    # Never let this off-owner scheduled process mutate the primary.
    # The provider credential must independently have D1 Read, not D1 Write.
    if not re.match(r"^SELECT\s", sql, re.IGNORECASE) or ";" in sql or re.search(
        r"\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH|PRAGMA)\b",
        sql, re.IGNORECASE
    ):
        raise RuntimeError("BioSync scheduled D1 is SELECT-only")
    payload = json.dumps({"sql": sql, "params": params or []}).encode()
    response = json.loads(authorized_request("POST", f"{BASE}/d1/database/{DATABASE}/query", payload, json_body=True))
    if not response.get("success"):
        raise RuntimeError(f"Cloudflare D1 query failed: {response.get('errors')}")
    return response["result"][0]["results"]


def r2_url(key: str) -> str:
    if ".." in key or key.startswith("/"):
        raise ValueError("Invalid R2 key")
    return f"{BASE}/r2/buckets/{BUCKET}/objects/{urllib.parse.quote(key, safe='/')}"


def download_verified(key: str, expected: str) -> bytes:
    raw = authorized_request("GET", r2_url(key))
    if hashlib.sha256(raw).hexdigest() != expected:
        raise RuntimeError(f"R2 object failed pinned SHA-256 validation: {key}")
    return raw


def check_map(mapping: dict, audio_sha: str, epub_sha: str, duration: float) -> None:
    verify = mapping["verification"]
    words = mapping["words"]
    if not (mapping["status"] == "checked" and mapping["version"] == 2
            and mapping["trackId"] == TRACK and mapping["audioSha256"] == audio_sha
            and mapping["epubSha256"] == epub_sha and mapping["engine"] == "cloudflare-workers-ai-whisper"
            and verify["method"] == "independent-asr-exact-text" and verify["confidenceMode"] == "unreported"
            and verify["minWordProbability"] is None and verify["coverage"] >= 0.9
            and len(words) >= 30 and len(words) == verify["matchedWords"]
            and verify["spokenWords"] >= len(words)
            and abs(mapping["duration"] - duration) <= 1):
        raise RuntimeError("The canary map has not passed the production verification contract")
    previous = None
    for word in words:
        if (word["probability"] is not None or
                not (0 <= word["start"] < word["end"] <= duration) or
                not word["href"] or ".." in word["href"] or
                not re.match(r"^epubcfi\(", word["cfi"]) or
                not re.match(r"^epubcfi\(", word["endCfi"]) or
                (previous and (word["wordIndex"] <= previous["wordIndex"]
                               or word["start"] < previous["end"]))):
            raise RuntimeError("A word cue failed monotonicity or provenance validation")
        previous = word


def choose_queued_short_track() -> bool:
    """Pick an independently transcribed and pinned short queued track."""
    global EDITION, TRACK, JOB
    prefix = "biosync/transcripts/cloudflare-whisper-v1/"
    try:
        result = json.loads(authorized_request(
            "GET", f"{BASE}/r2/buckets/{BUCKET}/objects?prefix={urllib.parse.quote(prefix)}&per_page=1000"
        ))
    except RuntimeError as error:
        print(f"Short BioSync auto-selector unavailable: {error}")
        return False
    objects = result.get("result", [])
    if isinstance(objects, dict):
        objects = objects.get("objects", [])
    cached = {str(item.get("key", "")) for item in objects if isinstance(item, dict)}
    if not cached:
        print("No independently hosted short-track ASR transcript is cached yet.")
        return False
    candidates = query(
        "SELECT j.id job_id,e.id edition_id,json_extract(t.value,'$.id') track_id,"
        "json_extract(t.value,'$.sha256') audio_sha FROM audio_jobs j "
        "JOIN audio_editions e ON e.id=json_extract(j.payload_json,'$.editionId') "
        "JOIN json_each(e.tracks_json) t ON json_extract(t.value,'$.id')=json_extract(j.payload_json,'$.trackId') "
        "LEFT JOIN audio_timing m ON m.edition_id=e.id AND m.track_id=json_extract(t.value,'$.id') "
        "WHERE j.kind='align' AND j.status='queued' AND j.attempts<6 "
        "AND e.epub_sha256 IS NOT NULL "
        "AND CAST(json_extract(t.value,'$.duration') AS REAL)>0 "
        "AND CAST(json_extract(t.value,'$.duration') AS REAL)<=240 "
        "AND m.map_sha256 IS NULL ORDER BY CAST(json_extract(t.value,'$.duration') AS REAL),j.id LIMIT 250"
    )
    possible = [x for x in candidates
                if f"{prefix}{x['audio_sha']}.json" in cached]
    if not possible:
        print("No queued short BioSync tracks have a complete hosted transcript and EPUB yet.")
        return False
    # Rotate only among actually transcribed candidates. A track failing
    # exact-text verification never blocks other candidates indefinitely.
    chosen = possible[(int(datetime.now(timezone.utc).timestamp()) // 3600) % len(possible)]
    EDITION, TRACK, JOB = chosen["edition_id"], chosen["track_id"], chosen["job_id"]
    print(f"Checking short BioSync candidate: {EDITION} / {TRACK}")
    return True


def commit_checked_map_to_owner(edition: str, track: str, job: str, map_sha: str) -> dict:
    base = urllib.parse.urlsplit(os.environ["COVE_BIOSYNC_OWNER_STAGE_URL"])
    if (base.scheme != "https" or not base.hostname or base.username or base.password
            or base.path not in ("", "/") or base.query or base.fragment):
        raise RuntimeError("BioSync owner stage origin must be a bare HTTPS origin")
    token = os.environ["COVE_BIOSYNC_MACHINE_TOKEN"]
    if not token.startswith("fore_svc_"):
        raise RuntimeError("A scoped Cove machine credential is required")
    url = urllib.parse.urlunsplit((
        "https", base.netloc, "/api/fore/machine/v1/biosync/publish-checked", "", ""
    ))
    payload = {
        "editionId": edition, "trackId": track, "jobId": job, "mapSha256": map_sha,
    }
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    class DenyRedirects(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise RuntimeError("BioSync owner endpoint redirected")
    try:
        with urllib.request.build_opener(DenyRedirects()).open(request, timeout=120) as response:
            if response.status != 200:
                raise RuntimeError("BioSync owner refused publication")
            receipt = json.loads(response.read(4096))
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"BioSync owner refused publication: HTTP {error.code}") from None
    if not isinstance(receipt, dict) or any(
        receipt.get(key) != expected for key, expected in (
            ("schema", "cove.owner-biosync-checked-publication.v1"),
            ("editionId", edition), ("trackId", track), ("jobId", job),
            ("mapSha256", map_sha), ("committed", True),
        )
    ) or not isinstance(receipt.get("replay"), bool):
        raise RuntimeError("BioSync owner receipt was absent or mismatched")
    return receipt


def main() -> None:
    if DATABASE not in QA_DATABASES or not re.fullmatch(
        r"cove-[a-z0-9-]{1,90}-biosync-qa", BUCKET
    ):
        raise RuntimeError("BioSync stage may access only its approved synthetic QA D1/R2")
    for secret in ("COVE_BIOSYNC_D1_READ_TOKEN", "COVE_BIOSYNC_R2_TOKEN",
                   "COVE_BIOSYNC_OWNER_STAGE_URL", "COVE_BIOSYNC_MACHINE_TOKEN"):
        if not os.environ.get(secret):
            raise RuntimeError(f"Configure {secret} for protected owner staging")
    if os.environ.get("BIOSYNC_AUTO_SHORT") == "1" and not choose_queued_short_track():
        return
    meta = query(
        "SELECT e.book_id,e.epub_sha256,e.language,e.tracks_json,a.status "
        "FROM audio_editions e JOIN audio_jobs a ON a.id=? "
        "WHERE e.id=?",
        [JOB, EDITION],
    )
    if len(meta) != 1:
        raise RuntimeError("Prepared canary edition and D1 job not present")
    row = meta[0]
    track = next((t for t in json.loads(row["tracks_json"]) if t["id"] == TRACK), None)
    if not track or not track.get("sha256") or not track.get("duration") or not row["epub_sha256"]:
        raise RuntimeError("Canary recording or pinned EPUB is not ready")
    if row["status"] == "running":
        raise RuntimeError("Refusing to override an active BioSync job lease")
    audio_sha, epub_sha = track["sha256"], row["epub_sha256"]
    existing = query("SELECT map_sha256 FROM audio_timing WHERE edition_id=? AND track_id=? AND audio_sha256=? AND epub_sha256=? LIMIT 1",
             [EDITION, TRACK, audio_sha, epub_sha])
    if existing:
        map_hash = existing[0]["map_sha256"]
        download_verified(f"biosync/maps/{map_hash}.json", map_hash)
        print("BioSync canary already published and verified in D1 and R2")
        return

    # The R2 cache object key includes the pinned audio digest. Its JSON
    # identity and hosted engine must match that same audio digest; unlike
    # published timing maps, a transcript has no separate stored blob digest.
    transcript = json.loads(authorized_request(
        "GET", r2_url(f"biosync/transcripts/cloudflare-whisper-v1/{audio_sha}.json")
    ))
    if (transcript.get("identity", {}).get("audioSha256") != audio_sha
            or transcript.get("engine") != "cloudflare-workers-ai-whisper"
            or transcript.get("confidenceMode") != "unreported"):
        raise RuntimeError("Independent hosted transcript does not match the recording")

    epub = download_verified(f"biosync/text/{epub_sha}.epub", epub_sha)
    local = Path("/tmp/cove-biosync-canary.epub")
    local.write_bytes(epub)
    try:
        index = build(local)
    finally:
        local.unlink(missing_ok=True)
    if index["epubSha256"] != epub_sha:
        raise RuntimeError("EPUB CFI index identity mismatch")

    mapping = align(index, transcript, TRACK, audio_sha)
    # Audit every returned EPUB anchor against the reindexed, exact file.
    # This prevents accidentally publishing a text/Cfi pair which merely
    # looks syntactically valid but refers to a different word or book.
    for cue in mapping.get("words", []):
        n = cue["wordIndex"]
        if not 0 <= n < len(index["words"]):
            raise RuntimeError("Checked word index exceeds EPUB word count")
        source = index["words"][n]
        if any(cue[k] != source[k] for k in ("cfi", "endCfi", "href", "text")):
            raise RuntimeError("Checked cue does not match pinned EPUB contents")
    mapping["duration"] = float(track["duration"])
    if mapping["status"] != "checked":
        explanation = "BioSync not publishable: " + mapping.get("reason", "insufficient evidence")
        if os.environ.get("BIOSYNC_AUTO_SHORT") == "1":
            print(explanation + ". Kept unpublished for review.")
            return
        raise RuntimeError(explanation)
    check_map(mapping, audio_sha, epub_sha, mapping["duration"])
    contents = json.dumps(mapping, separators=(",", ":"), ensure_ascii=False).encode()
    map_sha = hashlib.sha256(contents).hexdigest()
    key = f"biosync/maps/{map_sha}.json"
    upload = json.loads(authorized_request("PUT", r2_url(key), contents))
    if not upload.get("success"):
        raise RuntimeError(f"R2 rejected checked BioSync map: {upload.get('errors')}")
    download_verified(key, map_sha)  # Verify exact published R2 bytes before D1 points at them.

    # Re-check the exact identities before exposing a new map to readers.
    fresh = query("SELECT epub_sha256,tracks_json FROM audio_editions WHERE id=?", [EDITION])[0]
    current_track = next((t for t in json.loads(fresh["tracks_json"]) if t["id"] == TRACK), None)
    if fresh["epub_sha256"] != epub_sha or current_track is None or current_track.get("sha256") != audio_sha:
        raise RuntimeError("Audio/text identity changed during canary publication")

    # One typed, owner-verified operation replaces BOTH former D1 mutations.
    # No raw SQL, caller-chosen summary, or untrusted completion flag crosses.
    receipt = commit_checked_map_to_owner(EDITION, TRACK, JOB, map_sha)
    if receipt["replay"]:
        print("The exact owner-published timing map was already committed")
    final = query("SELECT map_sha256 FROM audio_timing WHERE edition_id=? AND track_id=?", [EDITION, TRACK])
    if not final or final[0]["map_sha256"] != map_sha:
        raise RuntimeError("Published map could not be verified in D1")
    print(f"BioSync published first checked map: {len(mapping['words'])} words, "
          f"{mapping['verification']['coverage']:.1%} anchored passage coverage, sha={map_sha}")


if __name__ == "__main__":
    main()

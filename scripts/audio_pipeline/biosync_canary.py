"""One-shot, idempotent, independently verified BioSync production canary.

GitHub Actions has enough ephemeral disk to index Cove's pinned EPUB and uses
the existing Cloudflare API token, without copying any Vercel service secret.
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
DATABASE = "4bd657ac-8789-403e-a28c-93aba8d0a989"
BUCKET = "cove-production-media"
EDITION = "pg-19504"
TRACK = "02"
JOB = "align-pg-19504-02-7fb5b7e4c4a400b1"
BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}"


def authorized_request(method: str, endpoint: str, payload: bytes | None = None, *, json_body=False) -> bytes:
    token = os.environ["CLOUDFLARE_API_TOKEN"]
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


def main() -> None:
    if not os.environ.get("CLOUDFLARE_API_TOKEN"):
        raise RuntimeError("Configure CLOUDFLARE_API_TOKEN in GitHub Actions")
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
        raise RuntimeError("Canary not publishable: " + mapping.get("reason", "insufficient evidence"))
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

    first, last = mapping["words"][0], mapping["words"][-1]
    summary = {
        "trackId": TRACK, "sha256": map_sha, "wordCount": len(mapping["words"]),
        "coverage": mapping["verification"]["coverage"],
        "firstCfi": first["cfi"], "lastCfi": last["endCfi"],
        "firstSecond": first["start"], "lastSecond": last["end"],
    }
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    query(
        "INSERT INTO audio_timing(edition_id,track_id,audio_sha256,epub_sha256,map_sha256,summary_json,updated_at) "
        "VALUES(?,?,?,?,?,?,?) ON CONFLICT(edition_id,track_id) DO UPDATE SET "
        "audio_sha256=excluded.audio_sha256,epub_sha256=excluded.epub_sha256,"
        "map_sha256=excluded.map_sha256,summary_json=excluded.summary_json,updated_at=excluded.updated_at",
        [EDITION, TRACK, audio_sha, epub_sha, map_sha, json.dumps(summary), now],
    )
    query(
        "UPDATE audio_jobs SET status='done',last_error=?,lease_token=NULL,lease_until=NULL,updated_at=? "
        "WHERE id=? AND status IN ('queued','review')",
        [f"Verified {len(mapping['words'])} independent ASR words; {mapping['verification']['coverage']:.1%} coverage", now, JOB],
    )
    final = query("SELECT map_sha256 FROM audio_timing WHERE edition_id=? AND track_id=?", [EDITION, TRACK])
    if not final or final[0]["map_sha256"] != map_sha:
        raise RuntimeError("Published map could not be verified in D1")
    print(f"BioSync published first checked map: {len(mapping['words'])} words, "
          f"{mapping['verification']['coverage']:.1%} anchored passage coverage, sha={map_sha}")


if __name__ == "__main__":
    main()

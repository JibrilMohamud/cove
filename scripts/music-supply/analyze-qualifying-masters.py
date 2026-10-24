#!/usr/bin/env python3
"""Isolated, bounded acoustic qualification of already rights-reviewed exact masters.

No customer DB, checkout or public media endpoints. The pinned model is loaded
once per batch; each master is downloaded, verified and decoded independently.
All state changes require a dedicated analyst token AND explicit operator opt-in.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import tempfile
import time
import urllib.error
import urllib.request

QA_ORIGIN = "https://cove-music-supply-isolated-qa.cove-jibrilmohamud.workers.dev"
PROFILE = pathlib.Path(__file__).resolve().parents[1] / "soundtracks" / "profile-audio.py"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


http = urllib.request.build_opener(NoRedirect)


def call(route, token, payload=None, lease=None):
    if not route.startswith("/v1/analysis/") or "?" in route or "#" in route:
        raise ValueError("Untrusted isolated analysis route")
    if payload is not None:
        body = json.dumps(payload, allow_nan=False, separators=(",", ":")).encode()
        if len(body) > 350000:
            raise ValueError("Analysis payload too large")
    else:
        body = None
    headers = {
        "Authorization": "Bearer " + token,
        "User-Agent": "CoveIsolatedMusicAnalysis/1",
    }
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if lease:
        headers["X-Cove-Music-Analysis-Lease"] = lease
    method = "GET" if route.endswith("/audio") else "POST"
    return http.open(
        urllib.request.Request(QA_ORIGIN + route, data=body, method=method, headers=headers),
        timeout=120,
    )


def download(job, token, destination):
    master_id = job["masterId"]
    master_sha = job["masterSha256"]
    expected_bytes = job["bytes"]
    lease = job["leaseToken"]
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}", master_id):
        raise ValueError("Untrusted recording ID")
    if not re.fullmatch(r"[0-9a-f]{64}", master_sha):
        raise ValueError("Invalid original master checksum")
    if type(expected_bytes) is not int or not 128 <= expected_bytes <= 25 * 1024 * 1024:
        raise ValueError("Invalid original master size")
    if not re.fullmatch(r"[a-f0-9-]{36}", lease):
        raise ValueError("Invalid lease token")
    digest = hashlib.sha256()
    count = 0
    with call(f"/v1/analysis/masters/{master_id}/audio", token, lease=lease) as source:
        if source.status != 200 or not source.headers.get("Content-Type", "").startswith("audio/"):
            raise ValueError("Expected verified private audio")
        if int(source.headers.get("Content-Length", "-1")) != expected_bytes:
            raise ValueError("Audio size changed")
        with open(destination, "xb") as output:
            while chunk := source.read(256 * 1024):
                count += len(chunk)
                if count > expected_bytes:
                    raise ValueError("Unexpected oversized master")
                digest.update(chunk)
                output.write(chunk)
    if count != expected_bytes or digest.hexdigest() != master_sha:
        raise ValueError("Original master SHA-256 mismatch")


def run(args):
    if not args.execute:
        print(json.dumps({"dryRun": True, "note": "No leases, supplier writes or analysis calls"}))
        return 0
    if os.environ.get("COVE_MUSIC_ANALYSIS_RUNNER_ENABLED") != "1":
        raise ValueError("Isolated analysis writes require separate explicit opt-in")
    token = os.environ.get("COVE_MUSIC_ANALYSIS_TOKEN", "")
    if len(token) < 40 or len(token) > 256:
        raise ValueError("Missing distinct isolated analyst token")
    if not args.semantic_model:
        raise ValueError("Automated acoustic qualification requires pinned model evidence")
    spec = importlib.util.spec_from_file_location("cove_isolated_audio_profile", PROFILE)
    analyzer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(analyzer)
    # Load the expensive model only once and reuse its text embeddings.
    model = analyzer.AudioSemantics()
    deadline = time.monotonic() + args.max_minutes * 60
    receipts = []
    for _ in range(args.max_tracks):
        if time.monotonic() > deadline:
            break
        with call("/v1/analysis/claim", token, payload={}) as response:
            job = json.load(response)
        if job.get("skipped") == "no_eligible_jobs":
            break
        ident = job.get("masterId", "invalid")
        try:
            with tempfile.TemporaryDirectory(prefix="cove-isolated-quiet-") as tmp:
                source = pathlib.Path(tmp) / "original.audio"
                download(job, token, source)
                report = analyzer.analyze(source, model)
            if report["sha256"] != job["masterSha256"] or report["bytes"] != job["bytes"]:
                raise ValueError("Analyzer output identity mismatch")
            route = f"/v1/analysis/jobs/{ident}/complete"
            with call(route, token, payload={"leaseToken": job["leaseToken"], "report": report}) as response:
                answer = json.load(response)
            receipts.append({"masterId": ident, "status": answer.get("status"), "tier": answer.get("tier")})
        except Exception as error:
            # Never print HTTP headers, URLs with tokens, media contents or raw legal evidence.
            receipts.append({"masterId": ident, "errorType": type(error).__name__})
            try:
                with call(
                    f"/v1/analysis/jobs/{ident}/fail",
                    token,
                    payload={"leaseToken": job["leaseToken"]},
                ):
                    pass
            except Exception:
                pass
        print(json.dumps(receipts[-1]), flush=True)
    print(json.dumps({"attempted": len(receipts), "failed": sum("errorType" in r for r in receipts)}))
    return 1 if any("errorType" in r for r in receipts) else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--semantic-model", action="store_true")
    parser.add_argument("--max-tracks", type=int, default=4)
    parser.add_argument("--max-minutes", type=int, default=20)
    args = parser.parse_args()
    if not 1 <= args.max_tracks <= 8 or not 1 <= args.max_minutes <= 30:
        parser.error("Require bounded 1–8 tracks, 1–30 minutes")
    raise SystemExit(run(args))


if __name__ == "__main__":
    main()

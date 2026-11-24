"""Production BioSync's least-privilege transport. No D1 mutation or legacy fallback."""
from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9"
PRIMARY = "4bd657ac-8789-403e-a28c-93aba8d0a989"
BUCKET = "cove-production-media"
API = "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT
D1 = API + "/d1/database/" + PRIMARY + "/query"
R2 = API + "/r2/buckets/" + BUCKET + "/objects"
OWNER = "https://cove-biosync-production-ingress.cove-jibrilmohamud.workers.dev/__cove/biosync/publish-checked"
SECRET_NAMES = ("COVE_BIOSYNC_PROD_D1_READ_TOKEN", "COVE_BIOSYNC_PROD_R2_TOKEN",
                "COVE_BIOSYNC_PROD_CLIENT_SECRET")


def enabled() -> bool:
    flag = os.environ.get("COVE_BIOSYNC_PROD_OWNER_MODE", "0")
    if flag not in ("0", "1"):
        raise RuntimeError("Invalid BioSync owner mode")
    return flag == "1"


def require_credentials():
    values = tuple(os.environ.get(name, "") for name in SECRET_NAMES)
    if (any(len(x) < 20 for x in values) or len(set(values)) != 3
            or not re.fullmatch(r"[0-9a-f]{64}", values[2])
            or os.environ.get("CLOUDFLARE_API_TOKEN")):
        raise RuntimeError("Three distinct production owner-mode credentials, no legacy deployment token, are required")
    return values


class DenyRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError("BioSync credential-bearing requests cannot redirect")


def read_sql(sql: object) -> bool:
    return (isinstance(sql, str) and len(sql) <= 8192
            and bool(re.match(r"^SELECT\s", sql, re.I))
            and not re.search(r";|\x00|--|/\*|\*/", sql)
            and not re.search(r"\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|TRIGGER|LOAD_EXTENSION)\b", sql, re.I))


def authorize(method: str, url: str, payload: bytes | None, json_body: bool):
    if not enabled():
        raise RuntimeError("Production BioSync owner transport not enabled")
    d1_token, r2_token, _ = require_credentials()
    if url == D1:
        try:
            body = json.loads(payload or b"null")
        except (TypeError, ValueError):
            raise RuntimeError("Invalid production D1 read") from None
        if (method != "POST" or not json_body or not isinstance(body, dict)
                or set(body) != {"sql", "params"} or not isinstance(body["params"], list)
                or not read_sql(body["sql"])):
            raise RuntimeError("Production BioSync D1 is SELECT-only")
        return d1_token
    parsed = urllib.parse.urlsplit(url)
    r2 = urllib.parse.urlsplit(R2)
    if (parsed.scheme != "https" or parsed.netloc != "api.cloudflare.com"
            or parsed.fragment or not (parsed.path == r2.path or parsed.path.startswith(r2.path + "/"))):
        raise RuntimeError("Production BioSync endpoint denied")
    if parsed.path == r2.path:
        query = urllib.parse.parse_qs(parsed.query, strict_parsing=True)
        if (method != "GET" or set(query) != {"prefix", "per_page"}
                or query["per_page"] != ["1000"]
                or query["prefix"] not in [["biosync/transcripts/cloudflare-whisper-v1/"], ["biosync/text/"]]):
            raise RuntimeError("Production BioSync inventory denied")
    else:
        key = urllib.parse.unquote(parsed.path[len(r2.path)+1:])
        if parsed.query:
            raise RuntimeError("Production BioSync object query denied")
        if method == "PUT":
            match = re.fullmatch(r"biosync/maps/([0-9a-f]{64})\.json", key)
            if (not match or not payload or not 512 <= len(payload) <= 8_000_000
                    or hashlib.sha256(payload).hexdigest() != match.group(1)):
                raise RuntimeError("Production BioSync map upload denied")
        elif method == "GET":
            if not re.fullmatch(r"biosync/(?:maps/[0-9a-f]{64}\.json|text/[0-9a-f]{64}\.epub|transcripts/cloudflare-whisper-v1/[0-9a-f]{64}\.json)", key):
                raise RuntimeError("Production BioSync object read denied")
        else:
            raise RuntimeError("Production BioSync object method denied")
    return r2_token


def request(method: str, url: str, payload: bytes | None = None, *, json_body=False) -> bytes:
    token = authorize(method, url, payload, json_body)
    headers = {"Authorization": "Bearer " + token}
    if json_body:
        headers["Content-Type"] = "application/json"
    elif payload is not None:
        headers["Content-Type"] = "application/octet-stream"
    req = urllib.request.Request(url, data=payload, method=method, headers=headers)
    try:
        with urllib.request.build_opener(DenyRedirects()).open(req, timeout=120) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Scoped BioSync provider request failed: HTTP {error.code}") from None


def commit(edition: str, track: str, job: str, sha: str) -> dict:
    if not enabled():
        raise RuntimeError("Production BioSync owner transport not enabled")
    _, _, token = require_credentials()
    payload = {"editionId": edition, "trackId": track, "jobId": job, "mapSha256": sha}
    if any(not re.fullmatch(r"[A-Za-z0-9_-]{2,160}", x) for x in (edition, track, job)) or not re.fullmatch(r"[0-9a-f]{64}", sha):
        raise RuntimeError("Invalid BioSync publication identity")
    req = urllib.request.Request(OWNER, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.build_opener(DenyRedirects()).open(req, timeout=120) as response:
            if response.status != 200 or response.headers.get("cache-control") != "no-store":
                raise RuntimeError("Production BioSync owner did not acknowledge")
            raw = response.read(4097)
            if len(raw) > 4096:
                raise RuntimeError("Production BioSync receipt exceeded limit")
            receipt = json.loads(raw)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Production BioSync owner refused: HTTP {error.code}") from None
    if (not isinstance(receipt, dict) or set(receipt) != set(payload) | {"schema", "committed", "replay"}
            or receipt.get("schema") != "cove.owner-biosync-checked-publication.v1"
            or receipt.get("committed") is not True or type(receipt.get("replay")) is not bool
            or any(receipt.get(key) != value for key, value in payload.items())):
        raise RuntimeError("Production BioSync owner receipt mismatch")
    return receipt

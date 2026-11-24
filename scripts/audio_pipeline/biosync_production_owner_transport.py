"""Production BioSync's least-privilege transport. No D1 mutation or legacy fallback."""
from __future__ import annotations

import hashlib
import hmac
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
import json
import os
import re
import subprocess
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9"
PRIMARY = "4bd657ac-8789-403e-a28c-93aba8d0a989"
BUCKET = "cove-production-media"
API = "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT
D1 = API + "/d1/database/" + PRIMARY + "/query"
R2 = API + "/r2/buckets/" + BUCKET + "/objects"
R2_ACCESS_KEY_ID = "8b44b8edebf071ba96ee47e9b34e95bc"
R2_HOST = ACCOUNT + ".r2.cloudflarestorage.com"
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


def s3_signed_request(method, path, params, payload, token, now=None):
    """Sign only the fixed default-jurisdiction production bucket. No raw token leaves CI."""
    now = now or datetime.now(timezone.utc)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    day = stamp[:8]
    scope = f"{day}/auto/s3/aws4_request"
    quote = lambda x: urllib.parse.quote(str(x), safe="-_.~")
    query = "&".join(f"{quote(k)}={quote(v)}" for k, v in sorted(params.items()))
    uri = "/" + BUCKET + ("/" + urllib.parse.quote(path, safe="/-_.~") if path else "")
    content_hash = hashlib.sha256(payload or b"").hexdigest()
    headers = {"host": R2_HOST, "x-amz-content-sha256": content_hash, "x-amz-date": stamp}
    signed = ";".join(sorted(headers))
    canonical_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))
    canonical = "\n".join((method, uri, query, canonical_headers, signed, content_hash))
    to_sign = "\n".join(("AWS4-HMAC-SHA256", stamp, scope,
                         hashlib.sha256(canonical.encode()).hexdigest()))
    key = ("AWS4" + hashlib.sha256(token.encode()).hexdigest()).encode()
    for part in (day, "auto", "s3", "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    headers["Authorization"] = (f"AWS4-HMAC-SHA256 Credential={R2_ACCESS_KEY_ID}/{scope}, "
                                f"SignedHeaders={signed}, Signature={signature}")
    return urllib.request.Request("https://" + R2_HOST + uri + ("?" + query if query else ""),
                                  data=payload, method=method, headers=headers)


def s3_call(method, path, params, payload, token):
    req = s3_signed_request(method, path, params, payload, token)
    try:
        with urllib.request.build_opener(DenyRedirects()).open(req, timeout=120) as response:
            limit = 2_000_000 if not path else 64_000_000
            data = response.read(limit + 1)
            if len(data) > limit:
                raise RuntimeError("Scoped BioSync S3 response exceeded bound")
            return data
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Scoped BioSync S3 {method} failed: HTTP {error.code}") from None


def s3_list(prefix, count, token):
    if prefix not in ("biosync/text/", "biosync/transcripts/cloudflare-whisper-v1/") or count not in (1, 1000):
        raise RuntimeError("Scoped BioSync S3 list denied")
    raw = s3_call("GET", "", {"list-type": "2", "prefix": prefix, "max-keys": str(count)}, None, token)
    root = ET.fromstring(raw)
    ns = {"s": "http://s3.amazonaws.com/doc/2006-03-01/"}
    if root.tag != "{" + ns["s"] + "}ListBucketResult":
        raise RuntimeError("Scoped BioSync S3 list envelope invalid")
    if root.findtext("s:Name", namespaces=ns) != BUCKET or root.findtext("s:Prefix", namespaces=ns) != prefix:
        raise RuntimeError("Scoped BioSync S3 list identity mismatch")
    keys = [x.findtext("s:Key", namespaces=ns) for x in root.findall("s:Contents", ns)]
    if len(keys) > count or any(not isinstance(k, str) or not k.startswith(prefix) for k in keys):
        raise RuntimeError("Scoped BioSync S3 list scope mismatch")
    return {"success": True, "result": [{"key": k} for k in keys]}


def s3_preflight():
    # No D1 or owner mutation, no secret logging; successful S3 signature
    # authenticates the exact inventory-pinned token ID and token value.
    _, token, _ = require_credentials()
    s3_list("biosync/text/", 1, token)
    print("cove_biosync_scoped_s3_read_verified")


def request(method: str, url: str, payload: bytes | None = None, *, json_body=False) -> bytes:
    token = authorize(method, url, payload, json_body)
    if url != D1:
        parsed = urllib.parse.urlsplit(url)
        base = urllib.parse.urlsplit(R2)
        if parsed.path == base.path:
            prefix = urllib.parse.parse_qs(parsed.query)["prefix"][0]
            return json.dumps(s3_list(prefix, 1000, token)).encode()
        key = urllib.parse.unquote(parsed.path[len(base.path)+1:])
        result = s3_call(method, key, {}, payload, token)
        return b'{"success":true}' if method == "PUT" else result
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
    # Same HTTP implementation as the activation probe; never retry a commit.
    helper = Path(__file__).with_name("biosync_owner_https.mjs")
    result = subprocess.run(
        ["node", str(helper)], input=json.dumps(payload), text=True,
        capture_output=True, timeout=135, check=False,
        env={"PATH": os.environ.get("PATH", os.defpath),
             "COVE_BIOSYNC_PROD_CLIENT_SECRET": token},
    )
    if result.returncode != 0:
        reason = result.stderr.strip()
        if not re.fullmatch(r"biosync_owner_[a-z0-9_]+", reason):
            reason = "biosync_owner_transport_failed"
        raise RuntimeError(reason)
    if len(result.stdout.encode()) > 4096:
        raise RuntimeError("Production BioSync receipt exceeded limit")
    receipt = json.loads(result.stdout)
    if (not isinstance(receipt, dict) or set(receipt) != set(payload) | {"schema", "committed", "replay"}
            or receipt.get("schema") != "cove.owner-biosync-checked-publication.v1"
            or receipt.get("committed") is not True or type(receipt.get("replay")) is not bool
            or any(receipt.get(key) != value for key, value in payload.items())):
        raise RuntimeError("Production BioSync owner receipt mismatch")
    return receipt


if __name__ == "__main__":
    try:
        s3_preflight()
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch(r"Scoped BioSync S3 GET failed: HTTP [0-9]{3}", message) else "Scoped BioSync S3 preflight failed closed", file=__import__("sys").stderr)
        raise SystemExit(1) from None

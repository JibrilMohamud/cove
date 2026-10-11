"""Bounded resumable acquisition of original Gutenberg files."""
from __future__ import annotations

import concurrent.futures
import hashlib
import json
import pathlib
import re
import time
import urllib.request
from urllib.parse import urlparse


def request(url, headers=None, method="GET", timeout=90):
    return urllib.request.urlopen(
        urllib.request.Request(
            url,
            headers={"User-Agent": "Cove-audio-pipeline/2.0", **(headers or {})},
            method=method,
        ),
        timeout=timeout,
    )


def mirror_url(url: str) -> str:
    """Map reviewed gutenberg.org asset URLs onto Cove's HTTPS Gutenberg mirror."""
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in ("www.gutenberg.org", "gutenberg.org")
        or parsed.username
        or parsed.password
        or parsed.port
    ):
        raise ValueError("Gutenberg source required")

    path = parsed.path
    generated = re.match(
        r"^/ebooks/(\d+)\.(epub3?)(?:\.(noimages|images))?$",
        path,
    )
    if generated:
        ident, fmt, variant = generated.groups()
        suffix = "-images" if variant == "images" else ""
        if fmt == "epub3":
            suffix += "-3"
        path = f"/cache/epub/{ident}/pg{ident}{suffix}.epub"

    files = re.match(r"^/(?:files|ebooks)/(\d+)/(.*)$", path)
    if files:
        ident, remainder = files.groups()
        directory = "/".join(ident[:-1]) or "0"
        path = f"/{directory}/{ident}/{remainder}"

    path = path.replace("/cache/generated/", "/cache/epub/")
    if path.startswith("/dirs/"):
        path = path[len("/dirs") :]
    return "https://gutenberg.pglaf.org" + path


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download(url, target, headers=None, workers=3, chunk_size=1024 * 1024):
    target = pathlib.Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)

    with request(url, headers, method="HEAD") as response:
        size = int(response.headers.get("content-length", "0"))
        etag = response.headers.get("etag") or response.headers.get("last-modified", "")

    if not 0 < size <= 1024**3:
        raise ValueError("Unsupported source size")

    identity = {"url": url, "size": size, "etag": etag}
    stamp = pathlib.Path(str(target) + ".source.json")
    if (
        target.exists()
        and target.stat().st_size == size
        and stamp.exists()
        and json.loads(stamp.read_text()) == identity
    ):
        return target

    parts = pathlib.Path(str(target) + ".parts")
    parts.mkdir(exist_ok=True)
    fingerprint = hashlib.sha256(
        json.dumps(identity, sort_keys=True).encode()
    ).hexdigest()[:16]

    def piece(start):
        end = min(size - 1, start + chunk_size - 1)
        output = parts / f"{fingerprint}-{start}"
        if output.exists() and output.stat().st_size == end - start + 1:
            return output

        for attempt in range(4):
            try:
                range_headers = {
                    **(headers or {}),
                    "Range": f"bytes={start}-{end}",
                    **({"If-Range": etag} if etag else {}),
                }
                with request(url, range_headers) as response:
                    valid = (
                        response.status == 206
                        and response.headers.get("Content-Range", "").split("/")[0]
                        == f"bytes {start}-{end}"
                    )
                    if not valid and not (
                        response.status == 200 and start == 0 and end == size - 1
                    ):
                        raise ValueError("Source range/identity changed")
                    data = response.read(end - start + 2)
                    if len(data) != end - start + 1:
                        raise ValueError("Incomplete source segment")

                temporary = pathlib.Path(str(output) + ".tmp")
                temporary.write_bytes(data)
                temporary.replace(output)
                return output
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2**attempt)

        raise RuntimeError("unreachable")

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        files = list(pool.map(piece, range(0, size, chunk_size)))

    temporary = pathlib.Path(str(target) + ".tmp")
    with temporary.open("wb") as output:
        for file in files:
            with file.open("rb") as source:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    output.write(block)

    temporary.replace(target)
    stamp.write_text(json.dumps(identity))
    for file in files:
        file.unlink()
    return target

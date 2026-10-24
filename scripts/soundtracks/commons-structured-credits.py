"""Fail-closed, original-file-specific Commons credit reconciliation.

Only Wikimedia's own Action API is queried, never FMA/Musopen websites.
Unverified fields never authorize an original master. This assists the
existing source-license fast lane; ambiguous claims stay in human review.
"""
import hashlib
import html
import json
import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser

COMMONS_API = "https://commons.wikimedia.org/w/api.php"
AGENT = "CoveOpenLicenseCurator/1.0 (https://cove-puce-theta.vercel.app/help)"
BLOCK = re.compile(
    r"(?i)(?:\b(?:by[-_ ]?nc(?:[-_/ .]|\b)|non[- ]?commercial|no[- ]?derivatives|by[-_ ]?nd(?:[-_/ .]|\b)|"
    r"all rights reserved|permission required|copyrighted recording)\b|"
    r"creativecommons\.org/licenses/by-nc|freemusicarchive\.org|musopen\.org|"
    r"free[ _-]*music[ _-]*archive)"
)
NAME = re.compile(r"^[A-Za-zÀ-ž][A-Za-zÀ-ž .,'-]{3,110}$")
ROLE = {
    "composer": re.compile(r"(?im)^(?:composer|composed by|music by)\s*[:=]\s*(.+)$"),
    "performer": re.compile(r"(?im)^(?:performer|performed by|played by|pianist|musician)\s*[:=]\s*(.+)$"),
}
LICENSE = {"CC0": "https://creativecommons.org/publicdomain/zero/1.0/",
           "CC-BY": "https://creativecommons.org/licenses/by/",
           "CC-BY-SA": "https://creativecommons.org/licenses/by-sa/"}

class StripHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
    def handle_data(self, data):
        self.parts.append(data)
    def text(self):
        return html.unescape(" ".join(self.parts)).replace("\xa0", " ")

def plain(raw):
    scrubber = StripHTML()
    scrubber.feed(str(raw or "")[:16000])
    return re.sub(r"\s+", " ", scrubber.text()).strip()

def decode_name(raw):
    name = plain(raw).strip(" .,:;-")
    return name if NAME.fullmatch(name) and len(name.split()) <= 8 else None

def normalized(name):
    import unicodedata
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return tuple(sorted(re.findall(r"[a-z]+", s)))

def exact_licence(row, meta):
    code = row.get("license_code")
    link = str(meta.get("LicenseUrl", {}).get("value") or "").rstrip("/") + "/"
    statement = plain(meta.get("LicenseShortName", {}).get("value")).casefold()
    expected = str(row.get("license_url") or "")
    if code not in LICENSE or link != expected:
        return False
    if code == "CC0":
        return statement in ("cc0", "cc0 1.0")
    tag = "cc by-sa " if code == "CC-BY-SA" else "cc by "
    return (statement.startswith(tag) and
            expected == LICENSE[code] + statement[len(tag):] + "/")

def extract_role(text, role):
    candidates = []
    # A role label must be the entire line. Do not parse unlabeled title
    # fragments, credits to organizations, or vague album/uploader aliases.
    for line in re.split(r"\n|<br\s*/?>|\r", str(text or ""), flags=re.I):
        stripped = plain(line)
        m = ROLE[role].fullmatch(stripped)
        if m:
            name = decode_name(m.group(1))
            if name:
                candidates.append(name)
    distinct = {normalized(c) for c in candidates}
    return candidates[0] if len(distinct) == 1 and candidates else None

def inspect_commons_file(row, response):
    """Return attested creator corrections with evidence, or an explicit hold.

    A changed original/source license is terminal for this exact task.
    """
    data = response.get("query", {}).get("pages", [])
    pages = list(data.values()) if isinstance(data, dict) else data
    if len(pages) != 1:
        return {}, "commons_page_unavailable"
    page = pages[0]
    expected_title = row.get("source_title")
    if page.get("title") != expected_title or not re.fullmatch(r"File:[^\n]{4,260}\.(?:ogg|oga|mp3)",str(expected_title or ""),re.I):
        return {}, "commons_page_identity_changed"
    info = (page.get("imageinfo") or [{}])[0]
    if (str(info.get("sha1", "")).lower() != row.get("source_sha1") or
        info.get("size") != row.get("source_size") or
        info.get("mime") not in ("audio/ogg","application/ogg","audio/mpeg")):
        return {}, "commons_audio_master_changed"
    meta = info.get("extmetadata") or {}
    if not exact_licence(row, meta):
        return {}, "commons_license_changed"
    wiki = str((page.get("revisions") or [{}])[0].get("slots",{}).get("main",{}).get("content") or "")
    raw_meta = str(info.get("metadata") or "")
    # Embedded tags and Commons wikitext can contradict an extmetadata CC
    # wrapper. Holds are permanent until positive human provenance evidence.
    if BLOCK.search(wiki + "\n" + raw_meta):
        return {}, "commons_conflicting_source_claim"
    description = meta.get("ImageDescription", {}).get("value") or ""
    author = meta.get("Artist", {}).get("value") or ""
    detail = plain(description)
    if BLOCK.search(detail + "\n" + plain(author)):
        return {}, "commons_conflicting_description"
    # Preserve row credits as baseline. Any newly recovered role must be
    # explicitly labeled AND must not conflict with another labeled value.
    composer = extract_role(description, "composer")
    performer = extract_role(description, "performer")
    if not performer:
        # Explicit role in wikitext is acceptable when it names the same
        # person as extmetadata Artist; an uploader credit alone is not enough.
        match = re.search(r"(?im)^\|\s*performer\s*=\s*([^\n|{}]+)$", wiki)
        from_wiki = decode_name(match.group(1)) if match else None
        credited = decode_name(author)
        if from_wiki and credited and normalized(from_wiki) == normalized(credited):
            performer = from_wiki
    if not composer:
        match = re.search(r"(?im)^\|\s*composer\s*=\s*([^\n|{}]+)$", wiki)
        composer = decode_name(match.group(1)) if match else None
    if not composer and not performer:
        return {}, "commons_no_explicit_role_evidence"
    if composer and performer and normalized(composer) == normalized(performer):
        return {}, "commons_roles_not_distinct"
    source_revision = (page.get("revisions") or [{}])[0]
    evidence = {
        "policy": "commons-file-credit-v1",
        "sourceTitle": expected_title,
        "sourceSha1": row["source_sha1"],
        "sourceLicense": row["license_code"],
        "sourceLicenseUrl": row["license_url"],
        "sourceRevision": source_revision.get("revid"),
        "sourceTimestamp": source_revision.get("timestamp"),
        "artistAsClaimed": plain(author)[:180],
        "composer": composer,
        "performer": performer,
    }
    evidence["evidenceSha256"] = hashlib.sha256(json.dumps(evidence,sort_keys=True).encode()).hexdigest()
    return {"composer":composer, "performer":performer, "evidence":evidence}, ""

def query_commons(row, opener=None):
    if opener is None:
        opener = urllib.request.build_opener(NoRedirect)
    title = str(row.get("source_title") or "")
    if not re.fullmatch(r"File:[^\n]{4,260}\.(?:ogg|oga|mp3)",title,re.I):
        raise ValueError("Invalid Commons filename")
    params = urllib.parse.urlencode({
        "action":"query","format":"json","formatversion":"2",
        "prop":"imageinfo|revisions","iiprop":"sha1|size|mime|extmetadata|metadata",
        "rvprop":"ids|timestamp|content","rvslots":"main","titles":title,"maxlag":"5"
    })
    request = urllib.request.Request(COMMONS_API+"?"+params,headers={"User-Agent":AGENT,"Api-User-Agent":AGENT,"Accept":"application/json"})
    with opener.open(request,timeout=20) as response:
        if response.status != 200:
            raise ValueError("Commons source unavailable")
        payload = response.read(300000)
        if len(payload) >= 300000:
            raise ValueError("Commons response too large")
    return inspect_commons_file(row,json.loads(payload))

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

#!/usr/bin/env python3
"""Copy the unapproved Commons evidence ledger to a physically separate QA account.

No source writes, no production bindings, no customer rights or publication.
Every future writer is serialized with this admission gate. The bounded receipt
is created only after both snapshots, the destination rows, and every measured
original/report have been verified. Interrupted copies can safely resume.
"""
import concurrent.futures
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import urllib.error
import urllib.parse
import urllib.request

SOURCE_ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9"
SOURCE_DB = "fe9a9dd2-64b8-451c-a356-9ec71d9ee211"
SOURCE_BUCKET = "cove-music-supply-qa-20261023"
QA_ACCOUNT = "f51e8ccbc394e2d6016ff8c2c303d54b"
QA_DB = "ecd15e38-6350-4806-abe2-3e26acead4ac"
QA_BUCKET = "cove-commons-detached-objects-qa"
WORKFLOWS = ("isolated-open-license-discovery.yml", "isolated-commons-audio-technical-qa.yml",
             "isolated-commons-review-cases.yml")
TABLES = ("music_open_source_candidates", "music_open_discovery_runs",
          "music_open_discovery_cursors", "music_open_technical_qa", "music_open_review_cases")
RECEIPT = "cove_commons_qa_migration_receipt"
SCHEMA = "cove.detached-commons-qa-copy.v1"
MAX_ROWS = 20000
MAX_BYTES = 26_214_400
ROOT = "https://api.cloudflare.com/client/v4/accounts/"
MIGRATIONS = pathlib.Path(__file__).resolve().parents[2] / "infra" / "music"

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None

OPENER = urllib.request.build_opener(NoRedirect)

def require(condition, code):
    if not condition:
        raise RuntimeError(code)

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False, allow_nan=False).encode()).hexdigest()

def ident(name):
    require(re.fullmatch(r"[a-z_][a-z0-9_]*", name), "commons_invalid_identifier")
    return '"' + name + '"'

def request(url, token, method="GET", data=None, limit=4_000_000, missing=False):
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": "Bearer " + token,
        "User-Agent": "CoveDetachedCommonsMigration/1.0",
        **({"Content-Type": "application/json" if url.endswith("/query") else
            "application/octet-stream"} if data is not None else {}),
    })
    try:
        with OPENER.open(req, timeout=90) as response:
            body = response.read(limit + 1)
            require(len(body) <= limit, "commons_response_too_large")
            return body
    except urllib.error.HTTPError as error:
        if missing and error.code == 404:
            return None
        raise RuntimeError("commons_provider_http_" + str(error.code)) from None

class D1:
    def __init__(self, account, db, token, read_only):
        require((account, db, read_only) in ((SOURCE_ACCOUNT, SOURCE_DB, True),
                                             (QA_ACCOUNT, QA_DB, False)),
                "commons_d1_target")
        self.url = ROOT + account + "/d1/database/" + db + "/query"
        self.token, self.read_only = token, read_only

    def query(self, sql, params=()):
        require(not self.read_only or re.match(r"^SELECT\b", sql), "commons_source_write_refused")
        data = json.dumps({"sql": sql, "params": list(params)}).encode()
        payload = json.loads(request(self.url, self.token, "POST", data))
        result = payload.get("result")
        require(payload.get("success") is True and isinstance(result, list) and
                len(result) == 1 and result[0].get("success") is True, "commons_d1_rejected")
        return result[0].get("results", [])

    def batch(self, statements):
        require(not self.read_only, "commons_source_batch_refused")
        payload = json.loads(request(self.url, self.token, "POST", json.dumps({
            "batch": [{"sql": sql, "params": list(params)} for sql, params in statements]
        }).encode()))
        result = payload.get("result")
        require(payload.get("success") is True and isinstance(result, list) and
                len(result) == len(statements) and all(row.get("success") is True for row in result),
                "commons_qa_batch_rejected")

def schema_contract():
    with sqlite3.connect(":memory:") as db:
        db.row_factory = sqlite3.Row
        for file in sorted(MIGRATIONS.glob("*.sql")):
            db.executescript(file.read_text())
        objects = [dict(row) for row in db.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'music_%'"
            " AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1"
            " ELSE 2 END,name")]
        columns = {}
        for obj in objects:
            if obj["type"] == "table":
                cols = db.execute("PRAGMA table_info(" + ident(obj["name"]) + ")").fetchall()
                columns[obj["name"]] = [(r["name"], r["type"], r["notnull"], r["pk"]) for r in cols]
        require(set(TABLES) <= set(columns), "commons_reviewed_schema_missing")
        return objects, columns

def snapshot(db, columns):
    existing = {x["name"] for x in db.query(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    require(existing - {"_cf_KV", "sqlite_sequence", RECEIPT} == set(columns),
            "commons_unexpected_tables")
    rows = {}
    for table, expected in columns.items():
        # SELECT-only table-valued pragma, also supported by D1.
        info = db.query("SELECT name,type,\"notnull\",pk FROM pragma_table_info(?) ORDER BY cid",
                        (table,))
        require([(x["name"], x["type"], x["notnull"], x["pk"]) for x in info] == expected,
                "commons_schema_column_mismatch")
        total = db.query("SELECT COUNT(*) AS n FROM " + ident(table))[0]["n"]
        require(type(total) is int and 0 <= total <= MAX_ROWS, "commons_row_bound")
        if table not in TABLES:
            require(total == 0, "commons_licensed_or_other_state_present")
            continue
        pk = [name for name, _, _, _ in sorted(
            [x for x in expected if x[3]], key=lambda x: x[3])]
        require(pk, "commons_primary_key_missing")
        fields = ",".join(ident(x[0]) for x in expected)
        order = ",".join(ident(x) for x in pk)
        data = []
        for offset in range(0, total, 64):
            data.extend(db.query("SELECT " + fields + " FROM " + ident(table) +
                                 " ORDER BY " + order + " LIMIT ? OFFSET ?", (64, offset)))
        require(len(data) == total, "commons_source_count_drift")
        rows[table] = data
    return rows

def objects_for(rows):
    result = {}
    for row in rows["music_open_technical_qa"]:
        require(row["rights_status"] == row["quiet_status"] == "unreviewed",
                "commons_unexpected_approval")
        if row["status"] == "held":
            require(row["audio_r2_key"] is None and row["report_r2_key"] is None,
                    "commons_held_object")
            continue
        require(row["status"] == "measured", "commons_unexpected_technical_state")
        audio, report = row["source_sha256"], row["report_sha256"]
        require(re.fullmatch(r"[a-f0-9]{64}", audio or "") and
                re.fullmatch(r"[a-f0-9]{64}", report or ""), "commons_object_digest")
        require(row["audio_r2_key"] in [f"music-open-qa/originals/{audio}.{ext}"
                                       for ext in ("ogg", "mp3")] and
                row["report_r2_key"] == f"music-open-qa/reports/{audio}/{report}.json",
                "commons_object_identity")
        size = row["original_bytes"]
        require(type(size) is int and 128 <= size <= MAX_BYTES, "commons_audio_size")
        for key, value in ((row["audio_r2_key"], (audio, size)), (row["report_r2_key"], (report, None))):
            require(key not in result or result[key] == value, "commons_object_conflict")
            result[key] = value
    require(all(x["status"] == "needs_review" for x in rows["music_open_review_cases"]),
            "commons_unexpected_review_approval")
    return result

def object_url(account, bucket, key):
    require((account, bucket) in ((SOURCE_ACCOUNT, SOURCE_BUCKET), (QA_ACCOUNT, QA_BUCKET)),
            "commons_object_bucket")
    require(re.fullmatch(r"music-open-qa/(?:originals/[a-f0-9]{64}\.(?:ogg|mp3)|"
                         r"reports/[a-f0-9]{64}/[a-f0-9]{64}\.json)", key),
            "commons_object_key")
    return ROOT + account + "/r2/buckets/" + bucket + "/objects/" + urllib.parse.quote(key, safe="/")

def verify_bytes(data, expected, size):
    require(data is not None and 0 < len(data) <= MAX_BYTES and
            (size is None or len(data) == size) and hashlib.sha256(data).hexdigest() == expected,
            "commons_object_hash_mismatch")

def copy_object(key, value, source_token, qa_token):
    expected, size = value
    src = object_url(SOURCE_ACCOUNT, SOURCE_BUCKET, key)
    dest = object_url(QA_ACCOUNT, QA_BUCKET, key)
    raw = request(src, source_token, limit=MAX_BYTES)
    verify_bytes(raw, expected, size)
    existing = request(dest, qa_token, limit=MAX_BYTES, missing=True)
    if existing is None:
        request(dest, qa_token, "PUT", raw, limit=1024)
        existing = request(dest, qa_token, limit=MAX_BYTES)
    verify_bytes(existing, expected, size)
    return len(raw)

ORPHAN_ID = 43097775228
ORPHAN_SHA = "bc582cf195ccd02ff2b1b68c3ae80bff29209497"
ORPHAN_WORKFLOW = "isolated-commons-audio-technical-qa.yml"

def exact_orphan(run, workflow, status):
    return (workflow == ORPHAN_WORKFLOW and status == "queued" and
            run.get("id") == ORPHAN_ID and run.get("head_sha") == ORPHAN_SHA and
            run.get("head_branch") == "main" and run.get("event") == "schedule" and
            run.get("path") == ".github/workflows/" + ORPHAN_WORKFLOW and
            run.get("status") == "queued")

def prove_orphan_fenced(token):
    # Queued/no jobs alone is NEVER enough. The archived source executes only
    # direct D1 REST and Cloudflare R2 API operations. Require the live
    # provider's complete account and user authorization inventories to prove
    # those writes unavailable; do not assume a GitHub secret's token identity.
    url = "https://api.github.com/repos/JibrilMohamud/cove/actions/runs/" + str(ORPHAN_ID)
    run = json.loads(request(url, token))
    require(exact_orphan(run, ORPHAN_WORKFLOW, "queued"), "commons_orphan_identity_changed")
    jobs = json.loads(request(url + "/jobs?filter=all&per_page=100", token))
    require(jobs.get("total_count") == 0 and jobs.get("jobs") == [],
            "commons_orphan_jobs_present")
    env = {k: os.environ.get(k, "") for k in (
        "PATH", "COVE_CF_ACCOUNT_TOKEN_INVENTORY_READ_TOKEN",
        "COVE_CF_USER_TOKENS_AUDIT_READ_TOKEN")}
    script = pathlib.Path(__file__).resolve().parents[1] / "release" / "verify-commons-archived-source-fence.mjs"
    result = subprocess.run(["node", str(script)], env=env, timeout=240,
                            capture_output=True, text=True)
    require(result.returncode == 0 and result.stdout.strip() == "COMMONS_ARCHIVED_SOURCE_FENCED",
            "commons_orphan_provider_write_fence_unverified")
    print("COMMONS_ORPHAN_PROVIDER_WRITE_FENCE_VERIFIED", flush=True)

def old_runs_quiescent():
    token = os.environ["GH_TOKEN"]
    current = os.environ["GITHUB_SHA"]
    run_id = os.environ["GITHUB_RUN_ID"]
    for workflow in WORKFLOWS:
        for status in ("in_progress", "queued", "waiting", "pending", "requested"):
            url = ("https://api.github.com/repos/JibrilMohamud/cove/actions/workflows/" +
                   workflow + "/runs?branch=main&status=" + status + "&per_page=100")
            payload = json.loads(request(url, token))
            runs = payload.get("workflow_runs")
            require(isinstance(runs, list) and len(runs) < 100 and
                    payload.get("total_count") == len(runs), "commons_run_inventory_incomplete")
            for run in runs:
                if (str(run["id"]) != run_id and run["head_sha"] != current and
                        run["event"] in ("push", "schedule", "workflow_dispatch")):
                    require(exact_orphan(run, workflow, status), "commons_legacy_writer_still_running")
                    prove_orphan_fenced(token)

def migrate(source, target, transfer, quiescent):
    objects, columns = schema_contract()
    existing = {x["name"] for x in target.query("SELECT name FROM sqlite_master WHERE type='table'")}
    require(existing <= set(columns) | {"_cf_KV", "sqlite_sequence", RECEIPT},
            "commons_destination_not_dedicated")
    if RECEIPT in existing:
        saved = target.query("SELECT schema_version,source_sha256,source_account,source_db,"
                             "qa_account,qa_db,qa_bucket,object_count FROM " + RECEIPT + " WHERE id=1")
        if saved:
            r = saved[0]
            require(len(saved) == 1 and r["schema_version"] == SCHEMA and
                    (r["source_account"], r["source_db"], r["qa_account"], r["qa_db"], r["qa_bucket"]) ==
                    (SOURCE_ACCOUNT, SOURCE_DB, QA_ACCOUNT, QA_DB, QA_BUCKET) and
                    re.fullmatch(r"[a-f0-9]{64}", r["source_sha256"]) and
                    type(r["object_count"]) is int and 0 <= r["object_count"] <= 2 * MAX_ROWS,
                    "commons_receipt_invalid")
            # Recheck the writer boundary on every use of a migrated ledger,
            # not merely the first receipt, and reject late source drift.
            quiescent()
            require(digest(snapshot(source, columns)) == r["source_sha256"],
                    "commons_archived_source_drift")
            return {"schema": SCHEMA, "alreadyVerified": True, "sourceMutation": False,
                    "objectCount": r["object_count"]}
    quiescent()
    rows = snapshot(source, columns)
    source_hash = digest(rows)
    refs = objects_for(rows)
    # Construct final reviewed schema from checked-in migrations, not from
    # executable SQL returned by the production provider.
    for obj in objects:
        kind = obj["type"]
        statement = re.sub(r"^CREATE (UNIQUE )?(TABLE|INDEX|TRIGGER) ",
                           lambda m: "CREATE " + (m[1] or "") + m[2] + " IF NOT EXISTS ",
                           obj["sql"], count=1, flags=re.I)
        require(statement != obj["sql"], "commons_schema_statement")
        target.query(statement)
    target.query("CREATE TABLE IF NOT EXISTS " + RECEIPT + "("
                 "id INTEGER PRIMARY KEY CHECK(id=1),schema_version TEXT NOT NULL,"
                 "source_sha256 TEXT NOT NULL,source_account TEXT NOT NULL,source_db TEXT NOT NULL,"
                 "qa_account TEXT NOT NULL,qa_db TEXT NOT NULL,qa_bucket TEXT NOT NULL,"
                 "object_count INTEGER NOT NULL)")
    # No consumer may use this new DB without the receipt. Retry only the
    # detached rows on interrupted copies, never the archived source ledger.
    partial = snapshot(target, columns)
    # A failed transfer may leave immutable evidence rows behind. Resume by
    # exact primary-key and full-row equality, never deleting or overwriting.
    missing = {}
    for table in TABLES:
        pk = [x[0] for x in sorted((x for x in columns[table] if x[3]), key=lambda x: x[3])]
        def key(row):
            return tuple(row[field] for field in pk)
        expected = {key(row): row for row in rows[table]}
        present = {key(row): row for row in partial[table]}
        require(all(k in expected and expected[k] == row for k, row in present.items()),
                "commons_partial_destination_drift")
        missing[table] = [row for row in rows[table] if key(row) not in present]
    for table in TABLES:
        fields = [x[0] for x in columns[table]]
        statement = ("INSERT INTO " + ident(table) + "(" + ",".join(map(ident, fields)) +
                     ") VALUES(" + ",".join("?" for _ in fields) + ")")
        data = missing[table]
        for offset in range(0, len(data), 24):
            target.batch([(statement, [row[field] for field in fields])
                          for row in data[offset:offset + 24]])
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        copied = sum(executor.map(lambda x: transfer(*x), refs.items()))
    quiescent()
    require(digest(snapshot(source, columns)) == source_hash, "commons_source_changed")
    require(digest(snapshot(target, columns)) == source_hash, "commons_destination_mismatch")
    target.query("INSERT INTO " + RECEIPT +
                 " VALUES(1,?,?,?,?,?,?,?,?)",
                 (SCHEMA, source_hash, SOURCE_ACCOUNT, SOURCE_DB, QA_ACCOUNT, QA_DB, QA_BUCKET, len(refs)))
    require(target.query("SELECT source_sha256 FROM " + RECEIPT + " WHERE id=1") ==
            [{"source_sha256": source_hash}], "commons_receipt_not_durable")
    return {"schema": SCHEMA, "sourceSha256": source_hash, "sourceMutation": False,
            "sourceCounts": {k: len(v) for k, v in rows.items()}, "objectCount": len(refs),
            "verifiedBytes": copied, "customerPublished": False, "rightsApproved": False}

def main():
    require(os.environ.get("GITHUB_REPOSITORY") == "JibrilMohamud/cove" and
            os.environ.get("GITHUB_REF") == "refs/heads/main" and
            os.environ.get("GITHUB_EVENT_NAME") in ("push", "schedule", "workflow_dispatch") and
            re.fullmatch(r"[a-f0-9]{40}", os.environ.get("GITHUB_SHA", "")),
            "commons_protected_main_required")
    require(not os.environ.get("CLOUDFLARE_API_TOKEN"), "commons_legacy_token_forbidden")
    require(os.environ.get("CLOUDFLARE_ACCOUNT_ID") == QA_ACCOUNT, "commons_qa_account_required")
    source, d1, r2 = (os.environ.get(x, "") for x in ("COVE_CF_STAGE_DATA_PLANE_READ_TOKEN",
                                                       "COVE_CF_QA_D1_MUTATION_TOKEN",
                                                       "COVE_CF_QA_R2_STORAGE_TOKEN"))
    require(all(len(x) >= 20 for x in (source, d1, r2)) and len({source, d1, r2}) == 3,
            "commons_scoped_credentials_required")
    result = migrate(D1(SOURCE_ACCOUNT, SOURCE_DB, source, True), D1(QA_ACCOUNT, QA_DB, d1, False),
                     lambda key, value: copy_object(key, value, source, r2), old_runs_quiescent)
    print(json.dumps(result, sort_keys=True))
    with open(os.environ["GITHUB_ENV"], "a") as output:
        output.write("COVE_COMMONS_QA_MIGRATION_VERIFIED=1\n")

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Full public delivery audit against an independently captured R2 manifest.

Downloads every byte, compares SHA-1 and byte length, and decodes each complete
original with ffmpeg. Never treats a database ready flag as playback evidence.
"""
import argparse
import concurrent.futures
import datetime as dt
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import tempfile
import urllib.request

spec = importlib.util.spec_from_file_location('probe', pathlib.Path(__file__).with_name('verify-production-playback.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

def check(row, expected):
    result = {'id': row['id']}
    try:
        url = probe.BASE + row['audioUrl']
        code, headers, _ = probe.fetch(url, 'HEAD')
        size = int(headers.get('Content-Length', '0'))
        if code != 200 or size != expected['bytes']:
            raise ValueError('HEAD length differs from R2 manifest')
        for offset in (0, size // 2, size - 2):
            code, headers, data = probe.fetch(url, headers={'Range': f'bytes={offset}-{offset+1}'})
            if code != 206 or len(data) != 2 or headers.get('Content-Range') != f'bytes {offset}-{offset+1}/{size}':
                raise ValueError('Public seeking failed')
        with tempfile.NamedTemporaryFile(suffix='.audio') as audio:
            request = urllib.request.Request(url, headers={'User-Agent': 'CoveCompleteAudioAudit/1.0'})
            digest, count = hashlib.sha1(), 0
            with probe.OPENER.open(request, timeout=90) as response:
                if response.status != 200 or not response.headers.get('Content-Type', '').startswith('audio/'):
                    raise ValueError('Not an audio response')
                while chunk := response.read(1024 * 1024):
                    count += len(chunk)
                    if count > expected['bytes']:
                        raise ValueError('Oversized response')
                    digest.update(chunk)
                    audio.write(chunk)
            audio.flush()
            if count != size or digest.hexdigest() != expected['sha1']:
                raise ValueError('Complete download differs from imported original')
            decoded = subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-i', audio.name,
                '-map', '0:a:0', '-f', 'null', '-'], capture_output=True, timeout=180)
            if decoded.returncode:
                raise ValueError('Complete audio decoding failed: ' + decoded.stderr.decode()[:250])
        result.update(bytes=size, sha1=digest.hexdigest(), head=True, seeking=True, fullDecode=True, passed=True)
    except Exception as error:
        result.update(passed=False, error=str(error)[:400])
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    if not manifest['completeListing'] or manifest['mismatchIds']:
        raise ValueError('Independent R2 audit failed')
    expected = {line.split()[0]: {'bytes': int(line.split()[1]), 'sha1': line.split()[2]}
                for line in manifest['manifest'].splitlines()}
    # Validate all public paths, mandatory attribution, territory and licenses.
    probe.run(limit=0, audit_slot=0)
    _, _, body = probe.fetch(probe.BASE + probe.PATH)
    rows = json.loads(body)['recordings']
    if set(expected) != {r['id'] for r in rows}:
        raise ValueError('Public/R2 snapshot ID sets differ; capture a fresh R2 snapshot')
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(check, row, expected[row['id']]) for row in rows]
        for future in concurrent.futures.as_completed(futures):
            item = future.result()
            results.append(item)
            print(f"{len(results)}/{len(rows)} {item['id']} passed={item['passed']}", flush=True)
    report = {'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'origin': probe.BASE,
              'r2CheckedAt': manifest['checkedAt'], 'publishedCount': len(rows),
              'verifiedCount': sum(r['passed'] for r in results), 'targetMin': 150,
              'bytes': sum(r.get('bytes', 0) for r in results),
              'results': sorted(results, key=lambda r: r['id'])}
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    return 0 if report['verifiedCount'] == len(rows) and len(rows) >= 150 else 1

if __name__ == '__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
"""Capture exact Commons revisions; never approves or downloads recordings."""
import argparse, datetime, hashlib, json, pathlib, urllib.parse, urllib.request
AGENT = 'CoveSoundtracks/0.3 (https://cove-puce-theta.vercel.app/help; recording-rights research)'
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', default='docs/soundtrack-candidates-2026-10-15.json')
    parser.add_argument('--output', default='docs/soundtracks/evidence')
    args = parser.parse_args()
    catalog = json.loads(pathlib.Path(args.catalog).read_text())
    out = pathlib.Path(args.output); out.mkdir(parents=True, exist_ok=True)
    for start in range(0, len(catalog), 10):
        batch = catalog[start:start+10]
        params = dict(action='query', format='json', formatversion='2', maxlag='5',
                      prop='revisions|imageinfo', rvprop='ids|timestamp|content', rvslots='main',
                      iiprop='url|mime|size|sha1|extmetadata', titles='|'.join(r['source_title'] for r in batch))
        url = 'https://commons.wikimedia.org/w/api.php?' + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={'User-Agent': AGENT, 'Api-User-Agent': AGENT})
        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.load(response)
        if 'error' in data: raise RuntimeError(data['error'])
        pages = {p['pageid']: p for p in data['query']['pages']}
        for row in batch:
            page = pages[int(row['id'][3:])]
            rev = page['revisions'][0]
            source = page['imageinfo'][0]
            payload = dict(recordingId=row['id'], capturedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                           sourcePage=row['source_page_url'], revisionId=rev['revid'],
                           permanentUrl='https://commons.wikimedia.org/w/index.php?oldid='+str(rev['revid']),
                           sourceSha1=source['sha1'], expectedSha1=row['source_sha1'], page=page)
            content = json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2)+'\n'
            path = out/(row['id']+'.json'); path.write_text(content)
            print(row['id'], rev['revid'], hashlib.sha256(content.encode()).hexdigest(),
                  'MATCH' if source['sha1']==row['source_sha1'] else 'CHANGED', flush=True)
if __name__ == '__main__': main()

from .media import download
from .catalog import bulk,edition
import tarfile,pathlib,re,json
p=pathlib.Path('.sites-runtime/pipeline');items=bulk(p);wanted={x['gutenbergId'] for x in items}
a=download('https://gutenberg.pglaf.org/cache/epub/feeds/rdf-files.tar.bz2',p/'rdf-files.tar.bz2',chunk_size=4*1024*1024)
cache=p/'rdf';cache.mkdir(exist_ok=True)
with tarfile.open(a,mode='r|bz2') as tar:
    for member in tar:
        m=re.search(r'pg(\d+)\.rdf$',member.name)
        if m and m[1] in wanted and member.size<4*1024*1024:
            with tar.extractfile(member) as f:(cache/(m[1]+'.rdf')).write_bytes(f.read())
result=[]
for row in items:
    if not(cache/(row['gutenbergId']+'.rdf')).exists():continue
    value=edition(row['gutenbergId'],row['candidates'])
    if value:e,fp=value;result.append({'edition':e,'fingerprints':fp})
(p/'catalog.json').write_text(json.dumps(items));(p/'editions.json').write_text(json.dumps(result,ensure_ascii=False))
print(json.dumps({'recordings':len(result),'tracks':sum(len(x['edition']['tracks']) for x in result)}),flush=True)

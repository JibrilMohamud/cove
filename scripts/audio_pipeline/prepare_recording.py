"""Prepare a complete real Gutenberg recording for checked initial import."""
from .catalog import edition,epub_source,text_record
from .media import download,mirror_url,sha256
from .epub_index import build
from .align import transcribe,align
from pathlib import Path
import json,sys,concurrent.futures,av
ident=sys.argv[1];book=sys.argv[2];root=Path('.sites-runtime/pipeline')/('pg-'+ident);root.mkdir(parents=True,exist_ok=True)
e,fp=edition(ident,[book],enrich=True);text=download(mirror_url(epub_source(book)),root/'book.epub');index=build(text);(root/'index.json').write_text(json.dumps(index));(root/'book.json').write_text(json.dumps(text_record(book)))
def prepare(t):
    audio=download(mirror_url(t['url']),root/(fp[t['id']]+'.audio'),workers=2);digest=sha256(audio)
    with av.open(str(audio)) as media:duration=media.duration/av.time_base
    t.update(sha256=digest,duration=duration)
    transcript=transcribe(audio,root/(digest+'.transcript.json'),threads=2)
    result=align(index,transcript,t['id'],digest)
    if result['status']!='checked':
        transcript=transcribe(audio,root/(digest+'.small.transcript.json'),model='small.en',threads=2);result=align(index,transcript,t['id'],digest)
    result['duration']=duration;(root/(t['id']+'.map.json')).write_text(json.dumps(result,ensure_ascii=False))
    print(json.dumps({'recording':ident,'track':t['id'],'status':result['status'],'verification':result.get('verification')}),flush=True);return t
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:e['tracks']=list(pool.map(prepare,e['tracks']))
e['epubSha256']=index['epubSha256'];(root/'prepared.json').write_text(json.dumps({'edition':e,'fingerprints':fp}));print('Prepared',ident,flush=True)

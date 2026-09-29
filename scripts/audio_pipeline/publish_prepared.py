"""Initial catalog/media import; exercises production validation, no direct database writes."""
from .runner import Api,config_from_stdin
from .media import sha256
from pathlib import Path
import json,concurrent.futures,sys
api=Api(config_from_stdin());root=Path('.sites-runtime/pipeline')
if '--catalog' in sys.argv:
    entries=json.loads((root/'editions.json').read_text())
    def one(p):return api.call('/pipeline/edition','PUT',p)
    workers=int(next((value.split('=',1)[1] for value in sys.argv if value.startswith('--workers=')),'8'))
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1,min(workers,16))) as pool:
        for i,_ in enumerate(pool.map(one,entries)):
            if (i+1)%50==0:print('Imported recordings:',i+1,flush=True)
    print('Catalog imported:',len(entries),flush=True)
for folder in root.glob('pg-*'):
    prepared=folder/'prepared.json'
    if not prepared.exists():continue
    p=json.loads(prepared.read_text());e=p['edition'];e['alignment']=None;api.call('/pipeline/edition','PUT',p)
    api.call('/pipeline/book','PUT',json.loads((folder/'book.json').read_text()))
    for t in e['tracks']:
        audio=folder/(p['fingerprints'][t['id']]+'.audio')
        api.call(f"/pipeline/media/{e['id']}/{t['id']}",'PUT',file=audio,headers={'x-content-sha256':sha256(audio),'x-audio-duration':str(t['duration']),'x-source-url':t['url']})
    api.call('/pipeline/text/'+e['id'],'PUT',file=folder/'book.epub',headers={'x-content-sha256':sha256(folder/'book.epub'),'x-book-id':e['bookId']})
    count=0
    for f in folder.glob('*.map.json'):
        m=json.loads(f.read_text())
        if m['status']=='checked':api.call(f"/pipeline/alignment/{e['id']}/{m['trackId']}",'PUT',m);count+=1
    print(json.dumps({'recording':e['id'],'checkedTracks':count,'tracks':len(e['tracks'])}),flush=True)
print(json.dumps(api.call('/audio-status')),flush=True)

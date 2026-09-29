import json,pathlib,concurrent.futures,urllib.request
root=pathlib.Path(__file__).resolve().parent.parent
books=json.loads((root/'src/features/fore/catalog-seed.json').read_text())['results']; out=root/'public/covers';out.mkdir(exist_ok=True)
def get(b):
 try:
  data=urllib.request.urlopen(b['formats']['image/jpeg'],timeout=25).read()
  if data[:2]!=b'\xff\xd8':raise ValueError('Not JPEG')
  (out/f"{b['id']}.jpg").write_bytes(data)
  return str(b['id'])
 except Exception as e:return str(b['id'])+': '+str(e)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 print('\n'.join(pool.map(get,books)))

#!/usr/bin/env python3
"""Convert a local Gutenberg RDF catalog to lossless, rights-filtered audio manifests.
Use the official RDF bulk archive/private mirror. This does not scrape book pages.
"""
import argparse, hashlib, json, os, pathlib, re, sys, time, urllib.request, xml.etree.ElementTree as ET
NS={'pg':'http://www.gutenberg.org/2009/pgterms/','d':'http://purl.org/dc/terms/','rdf':'http://www.w3.org/1999/02/22-rdf-syntax-ns#'}
def natural(s): return [int(x) if x.isdigit() else x.lower() for x in re.split('(\\d+)',s)]
def normalize(s): return re.sub(r'[^\w]+',' ',s.casefold()).strip()
def build(root,links,voices):
 for path in sorted(pathlib.Path(root).rglob('*.rdf')):
  try:
   tree=ET.parse(path);e=tree.find('.//pg:ebook',NS)
   if e is None: continue
   id=e.get('{'+NS['rdf']+'}about','').rstrip('/').split('/')[-1]
   if not id.isdigit(): continue
   rights=e.find('d:rights',NS)
   if rights is None or rights.text!='Public domain in the USA.':continue
   title=e.findtext('d:title','',NS);tracks=[]
   for f in e.findall('d:hasFormat/pg:file',NS):
    source=f.get('{'+NS['rdf']+'}about','')
    if not source.lower().endswith('.mp3'):continue
    if not re.match(r'https?://(?:www\.)?gutenberg.org/',source):continue
    size=f.findtext('d:extent','',NS)
    tracks.append({'url':source.replace('http:','https:',1),'mime':'audio/mpeg',**({'bytes':int(size)} if size.isdigit() else {})})
   if not tracks:continue
   # Retain all track URLs; a MIME -> URL dictionary would discard all but one.
   tracks.sort(key=lambda t:natural(t['url']))
   for i,t in enumerate(tracks):t.update(id=f'{i+1:03}',title=f'Track {i+1}')
   override=links.get(id,{})
   if isinstance(override,str):override={'bookId':override}
   narration=voices.get(id,{});narration={'narration':narration} if isinstance(narration,str) else narration
   yield {'id':'pg-'+id,'gutenbergId':id,'bookId':override.get('bookId'),'title':title,'authors':[{'name':n.text} for n in e.findall('d:creator/pg:agent/pg:name',NS) if n.text],'language':e.findtext('d:language/rdf:Description/rdf:value','und',NS),'narration':narration.get('narration','unknown'),'narrator':narration.get('narrator',''),'sourceUrl':'https://www.gutenberg.org/ebooks/'+id,'rights':rights.text,'tracks':tracks,'alignment':None,'epubSha256':None}
  except (ET.ParseError,ValueError) as error: print(f'Skipping {path.name}: {error}',file=sys.stderr)
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--rdf-root',required=True);p.add_argument('--links',help='Reviewed audio-ID to text-ID JSON map');p.add_argument('--voices',help='Verified narration classification JSON map');p.add_argument('--output',required=True);p.add_argument('--publish',help='Cove HTTPS site URL');p.add_argument('--checkpoint',default='.audio-import-checkpoint.json');p.add_argument('--prepare-audio',action='store_true',help='Cache each track through the configured mirror; sequential, restartable');p.add_argument('--interval',type=int,default=0,help='Repeat local catalog scan every N seconds (>=300), for a service/cron runner');a=p.parse_args()
 if a.interval and a.interval<300:p.error('The repeat interval must be at least 300 seconds.')
 links=json.loads(pathlib.Path(a.links).read_text()) if a.links else {};voices=json.loads(pathlib.Path(a.voices).read_text()) if a.voices else {}
 def request(path,value):
  token=os.environ.get('FORE_SERVICE_TOKEN');
  if not token:raise SystemExit('Set FORE_SERVICE_TOKEN issued to an audio-ingestion service principal. Never place it in source control.')
  if not a.publish.startswith('https://'):raise SystemExit('Publishing requires HTTPS.')
  req=urllib.request.Request(a.publish.rstrip('/')+'/api/fore'+path,data=json.dumps(value).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+token},method='POST' if '/prepare/' in path else 'PUT')
  with urllib.request.urlopen(req,timeout=180) as response:return json.load(response)
 while True:
  editions=list(build(a.rdf_root,links,voices));pathlib.Path(a.output).write_text(json.dumps(editions,indent=2)+'\n');print(f'{len(editions)} public-domain recordings; classifications require explicit source evidence.')
  if a.publish:
   checkpoint=pathlib.Path(a.checkpoint);done=json.loads(checkpoint.read_text()) if checkpoint.exists() else {}
   for e in editions:
    digest=hashlib.sha256(json.dumps(e,sort_keys=True).encode()).hexdigest()
    if done.get(e['id'])!=digest:request('/admin/audio',e);done[e['id']]=digest;checkpoint.write_text(json.dumps(done))
    if a.prepare_audio:
     for track in e['tracks']:
      key=e['id']+':'+track['id']+':'+digest
      if done.get(key):continue
      request('/audio/'+e['id']+'/prepare/'+track['id'],{});done[key]=True;checkpoint.write_text(json.dumps(done));time.sleep(2)
  if not a.interval:break
  time.sleep(a.interval)
if __name__=='__main__':main()

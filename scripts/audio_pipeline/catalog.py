"""Official bulk CSV/RDF and daily RSS; only explicitly public-domain records enter Cove."""
import csv,gzip,hashlib,io,json,re,os,time,xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse
from .media import request,mirror_url
NS={'rdf':'http://www.w3.org/1999/02/22-rdf-syntax-ns#','d':'http://purl.org/dc/terms/','pg':'http://www.gutenberg.org/2009/pgterms/'}
R='{'+NS['rdf']+'}';D='{'+NS['d']+'}';P='{'+NS['pg']+'}'
def norm(s):return re.sub(r'[^\w]+',' ',s.casefold()).strip()
def title_key(s):return norm(re.split(r'\s*[:;\n]|\s*\((?:audio|human|computer)',s,flags=re.I)[0])
def bulk(cache):
    path=Path(cache)/'pg_catalog.csv';path.parent.mkdir(parents=True,exist_ok=True)
    if not path.exists() or time.time()-path.stat().st_mtime>20*3600:
        with request('https://gutenberg.pglaf.org/cache/epub/feeds/pg_catalog.csv.gz') as r:data=gzip.decompress(r.read(15*1024*1024))
        temp=path.with_suffix('.tmp');temp.write_bytes(data);temp.replace(path)
    rows=list(csv.DictReader(io.StringIO(path.read_text(encoding='utf-8-sig'))));texts={}
    for row in rows:
        if row['Type']=='Text':texts.setdefault((title_key(row['Title']),row['Language'].split(';')[0],norm(row['Authors'])),[]).append(row['Text#'])
    result=[{'gutenbergId':r['Text#'],'candidates':texts.get((title_key(r['Title']),r['Language'].split(';')[0],norm(r['Authors'])),[])[:8],'title':r['Title']} for r in rows if r['Type']=='Sound']
    try:
        with request('https://gutenberg.pglaf.org/cache/epub/feeds/today.rss') as r:feed=ET.fromstring(r.read(2*1024*1024))
        ids={x['gutenbergId'] for x in result}
        for item in feed.iter():
            if item.tag.endswith('link') and item.text:
                m=re.search(r'/ebooks/(\d+)',item.text)
                if m and m[1] not in ids:result.append({'gutenbergId':m[1],'candidates':[],'title':''});ids.add(m[1])
    except Exception:pass
    return result

def metadata(ident):
    cache=Path(os.environ.get('FORE_RDF_CACHE','.sites-runtime/pipeline/rdf'));cache.mkdir(parents=True,exist_ok=True);path=cache/(ident+'.rdf')
    if path.exists() and time.time()-path.stat().st_mtime<20*3600:raw=path.read_bytes()
    else:
        with request(mirror_url(f'https://www.gutenberg.org/cache/epub/{ident}/pg{ident}.rdf')) as r:raw=r.read(4*1024*1024)
        path.write_bytes(raw)
    root=ET.fromstring(raw);book=root.find(P+'ebook')
    if book is None:raise ValueError('Gutenberg record missing')
    def values(p):return [n.text.strip() for n in book.findall(p,NS) if n.text]
    if values('d:rights')!=['Public domain in the USA.']:return None
    files=[]
    for f in book.findall('d:hasFormat/pg:file',NS):
        url=f.get(R+'about','').replace('http://','https://',1)
        if urlparse(url).hostname in ('www.gutenberg.org','gutenberg.org'):files.append({'url':url,'bytes':int(f.findtext(D+'extent','0')),'modified':f.findtext(D+'modified','')})
    return {'id':ident,'title':(values('d:title') or [ident])[0],'authors':[{'name':n} for n in values('d:creator/pg:agent/pg:name')],'language':(values('d:language/rdf:Description/rdf:value') or ['und'])[0],'types':values('d:type/rdf:Description/rdf:value'),'files':files,'shelves':values('pg:bookshelf/rdf:Description/rdf:value'),'subjects':values('d:subject/rdf:Description/rdf:value')}

def epub_source(ident):
    m=metadata(ident)
    if not m or 'Text' not in m['types']:raise ValueError('Matching text is not confirmed public domain')
    urls=[f['url'] for f in m['files'] if '.epub' in f['url']];urls.sort(key=lambda s:('noimages' not in s,'epub3' not in s))
    if not urls:raise ValueError('No EPUB available')
    return urls[0]
def text_record(ident):
    m=metadata(ident)
    if not m or 'Text' not in m['types']:raise ValueError('Text is not public domain')
    return {'id':ident,'title':m['title'],'authors':m['authors'],'copyright':False,'subjects':m['subjects'],'bookshelves':m['shelves'],'languages':[m['language']],'formats':{'application/epub+zip':epub_source(ident)},'download_count':0}

def edition(ident,candidates,enrich=False):
    m=metadata(ident)
    if not m or 'Sound' not in m['types']:return None
    tracks=next((files for ext in ('.mp3','.m4b','.ogg') if (files:=[f for f in m['files'] if urlparse(f['url']).path.lower().endswith(ext)])),[])
    if not tracks or len(tracks)>500:return None
    tracks.sort(key=lambda f:[int(s) if s.isdigit() else s.lower() for s in re.split(r'(\d+)',f['url'])])
    e={'id':'pg-'+ident,'gutenbergId':ident,'bookId':candidates[0] if len(candidates)==1 else None,'title':m['title'],'authors':m['authors'],'language':m['language'],'narration':'unknown','narrator':'','sourceUrl':'https://www.gutenberg.org/ebooks/'+ident,'rights':'Public domain in the USA.','alignment':None,'epubSha256':None,'tracks':[]}
    if ident=='20686':e.update(bookId='1342',narration='human',narrator='Annie Coleman')
    if enrich:
        sources=[f['url'] for f in m['files'] if re.search(r'read.?me.*\.txt$',f['url'],re.I)]
        if sources:
            try:
                with request(mirror_url(sources[0])) as r:lead=r.read(512*1024).decode('utf-8-sig',errors='replace').split('THE FULL PROJECT GUTENBERG LICENSE')[0]
                if re.search(r'computer.generated|synthe(?:sized|tic) (?:voice|speech)|text.to.speech',lead,re.I):e['narration']='computer'
                elif re.search(r'libri\s?vox|read(?:ing)? by',lead,re.I):e['narration']='human'
                names=[n.strip() for n in re.findall(r'(?:Read by|Reading by)\s*:?\s*([^\r\n]+)',lead,re.I) if len(n.strip())<150]
                if names:e['narrator']='; '.join(dict.fromkeys(names))[:500]
            except Exception:pass
    fp={}
    for i,f in enumerate(tracks):
        tid=f'{i+1:02d}';ext=urlparse(f['url']).path.rsplit('.',1)[-1]
        e['tracks'].append({'id':tid,'title':f'Track {i+1}','url':f['url'],'mime':{'mp3':'audio/mpeg','m4b':'audio/mp4','ogg':'audio/ogg'}[ext],**({'bytes':f['bytes']} if f['bytes'] else {})});fp[tid]=hashlib.sha256(json.dumps(f,sort_keys=True).encode()).hexdigest()
    return e,fp

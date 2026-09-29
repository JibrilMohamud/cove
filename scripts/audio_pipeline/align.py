"""Independent transcription plus exact, monotonic word checks. No invented timings."""
import collections,difflib,json,pathlib,time,os
from .epub_index import normalize
from .media import sha256

def transcribe(path,output,model='base.en',language='en',threads=4):
    from faster_whisper import WhisperModel
    target=pathlib.Path(output);identity={'audioSha256':sha256(path),'model':model,'language':language}
    if target.exists():
        cached=json.loads(target.read_text())
        if cached.get('identity')==identity:return cached
    engine=WhisperModel(model,device='cpu',compute_type='int8',cpu_threads=threads,download_root=os.environ.get('FORE_MODEL_CACHE','.sites-runtime/models'))
    segments,info=engine.transcribe(str(path),language=language,beam_size=5,word_timestamps=True,vad_filter=True,condition_on_previous_text=False)
    words=[]
    for segment in segments:
        for w in segment.words or []:
            token=normalize(w.word)
            if token and w.end>w.start:words.append({'text':w.word.strip(),'norm':token,'start':round(w.start,3),'end':round(w.end,3),'probability':round(w.probability,4)})
    result={'identity':identity,'engine':'faster-whisper/'+model,'language':info.language,'duration':info.duration,'words':words};tmp=target.with_suffix('.tmp');tmp.write_text(json.dumps(result));tmp.replace(target);return result

def align(index,transcript,track_id,audio_sha):
    book=index['words'];speech=transcript['words'];a=[w['norm'] for w in book];b=[w['norm'] for w in speech];anchors=collections.defaultdict(list)
    for i in range(len(a)-4):anchors[tuple(a[i:i+5])].append(i)
    votes=collections.Counter()
    for j in range(len(b)-4):
        positions=anchors.get(tuple(b[j:j+5]),[])
        if len(positions)==1:votes[(positions[0]-j)//100]+=1
    if not votes:return {'status':'needs-review','reason':'No unique text/audio anchors','words':[]}
    offset=votes.most_common(1)[0][0]*100;lo=max(0,offset-600);hi=min(len(a),offset+len(b)+1000);accepted=[];last=-1
    for block in difflib.SequenceMatcher(None,a[lo:hi],b,autojunk=False).get_matching_blocks():
        if block.size<5:continue
        absolute=lo+block.a
        if block.size<8 and len(anchors.get(tuple(a[absolute:absolute+5]),[]))!=1:continue
        for k in range(block.size):
            n=absolute+k;spoken=speech[block.b+k];written=book[n]
            if spoken['probability']<.72 or spoken['start']<last:continue
            accepted.append({key:written[key] for key in ('cfi','endCfi','href','text')}|{key:spoken[key] for key in ('start','end','probability')}|{'wordIndex':n});last=spoken['end']
    interior=[w for w in speech if accepted and w['start']>=accepted[0]['start'] and w['end']<=accepted[-1]['end']];coverage=len(accepted)/max(1,len(interior))
    result={'version':2,'trackId':track_id,'epubSha256':index['epubSha256'],'audioSha256':audio_sha,'duration':transcript['duration'],'engine':transcript['engine'],'words':accepted,'verification':{'method':'independent-asr-exact-text','automatic':True,'minWordProbability':.72,'matchedWords':len(accepted),'spokenWords':len(speech),'coverage':round(min(1,coverage),4),'checkedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}}
    result['status']='checked' if len(accepted)>=30 and coverage>=.8 else 'needs-review'
    if result['status']!='checked':result['reason']='Less than 80% of the spoken passage passed exact word checks'
    return result

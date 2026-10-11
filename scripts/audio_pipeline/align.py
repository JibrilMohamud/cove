"""Independent transcription plus exact, monotonic word checks. No invented timings."""
import collections,difflib,json,pathlib,time,os
from .epub_index import normalize
from .media import sha256
from .model_storage import prepare_model

def _install_pyav_compat():
    """Bridge faster-whisper 1.2.1 to PyAV 19 without masking unrelated failures."""
    import av
    current=av.open
    if getattr(current,'__cove_metadata_errors_compat__',False):return
    def compatible_open(*args,**kwargs):
        try:
            return current(*args,**kwargs)
        except TypeError as error:
            if 'metadata_errors' not in kwargs or 'metadata_errors' not in str(error):
                raise
            retry=dict(kwargs);retry.pop('metadata_errors',None)
            return current(*args,**retry)
    compatible_open.__cove_metadata_errors_compat__=True
    av.open=compatible_open

def transcribe(path,output,model='base.en',language='en',threads=4):
    target=pathlib.Path(output);identity={'audioSha256':sha256(path),'model':model,'language':language}
    if target.exists():
        cached=json.loads(target.read_text())
        if cached.get('identity')==identity:return cached
    model_path=prepare_model(model,os.environ.get('FORE_MODEL_CACHE','.sites-runtime/models'))
    _install_pyav_compat()
    from faster_whisper import WhisperModel
    engine=WhisperModel(model_path,device='cpu',compute_type='int8',cpu_threads=threads,local_files_only=True)
    segments,info=engine.transcribe(str(path),language=language,beam_size=5,word_timestamps=True,vad_filter=True,condition_on_previous_text=False)
    words=[]
    for segment in segments:
        for w in segment.words or []:
            token=normalize(w.word)
            if token and w.end>w.start:words.append({'text':w.word.strip(),'norm':token,'start':round(w.start,3),'end':round(w.end,3),'probability':round(w.probability,4)})
    result={'identity':identity,'engine':'faster-whisper/'+model,'language':info.language,'duration':info.duration,'words':words};tmp=target.with_suffix('.tmp');tmp.write_text(json.dumps(result));tmp.replace(target);return result

def align(index,transcript,track_id,audio_sha):
    book=index['words'];speech=transcript['words']
    confidence_unreported=transcript.get('confidenceMode')=='unreported'
    if confidence_unreported and transcript.get('engine')!='cloudflare-workers-ai-whisper':
        raise ValueError('Unreported ASR confidence only allowed for the reviewed hosted speech engine')
    a=[w['norm'] for w in book];b=[w.get('norm') or normalize(w['text']) for w in speech];anchors=collections.defaultdict(list)
    for i in range(len(a)-4):anchors[tuple(a[i:i+5])].append(i)
    votes=collections.Counter()
    for j in range(len(b)-4):
        positions=anchors.get(tuple(b[j:j+5]),[])
        if len(positions)==1:votes[(positions[0]-j)//100]+=1
    if not votes:return {'status':'needs-review','reason':'No unique text/audio anchors','words':[]}
    offset=votes.most_common(1)[0][0]*100;lo=max(0,offset-600);hi=min(len(a),offset+len(b)+1000);accepted=[];last=-1
    blocks=[block for block in difflib.SequenceMatcher(None,a[lo:hi],b,autojunk=False).get_matching_blocks() if block.size]
    def trusted_long(block):
        if block.size<5:return False
        absolute=lo+block.a
        return block.size>=8 or len(anchors.get(tuple(a[absolute:absolute+5]),[]))==1
    strong=[i for i,block in enumerate(blocks) if trusted_long(block)]
    # ASR homophone errors break a poem into small exact matching islands.
    # A short island is only accepted *between* independent long matching
    # anchors with a bounded gap on both the book and audio axes. A stray
    # word in the spoken intro/outro can never become an accepted cue.
    for block_index,block in enumerate(blocks):
        if not trusted_long(block):
            left=next((blocks[i] for i in reversed(strong) if i<block_index),None)
            right=next((blocks[i] for i in strong if i>block_index),None)
            if not left or not right:
                continue
            gap_text=right.a-(left.a+left.size)
            gap_speech=right.b-(left.b+left.size)
            if not (0<=gap_text<=24 and 0<=gap_speech<=24):
                continue
        absolute=lo+block.a
        for k in range(block.size):
            n=absolute+k;spoken=speech[block.b+k];written=book[n]
            probability=spoken.get('probability')
            if (probability is None and not confidence_unreported) or (probability is not None and probability < .72) or spoken['start']<last:continue
            accepted.append({key:written[key] for key in ('cfi','endCfi','href','text')}|{key:spoken[key] for key in ('start','end')}|{'probability':probability,'wordIndex':n});last=spoken['end']
    # Long audiobook forewords, LibriVox introductions and end credits may
    # exactly match isolated EPUB metadata or boilerplate. They are separate
    # from the narrated passage and must not lower its coverage or become
    # false location cues. Keep the largest time/text-contiguous checked run;
    # a future multi-chapter map may retain multiple independently verified
    # runs once each passes the same checks.
    clusters=[];current=[]
    for word in accepted:
        if current and (word['wordIndex']-current[-1]['wordIndex']>24 or word['start']-current[-1]['end']>12):
            clusters.append(current);current=[]
        current.append(word)
    if current:clusters.append(current)
    if clusters:accepted=max(clusters,key=len)
    interior=[w for w in speech if accepted and w['start']>=accepted[0]['start'] and w['end']<=accepted[-1]['end']];coverage=len(accepted)/max(1,len(interior))
    result={'version':2,'trackId':track_id,'epubSha256':index['epubSha256'],'audioSha256':audio_sha,'duration':transcript['duration'],'engine':transcript['engine'],'words':accepted,'verification':{'method':'independent-asr-exact-text','automatic':True,'minWordProbability':None if confidence_unreported else .72,'confidenceMode':'unreported' if confidence_unreported else 'word-probability','matchedWords':len(accepted),'spokenWords':len(speech),'coverage':round(min(1,coverage),4),'checkedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}}
    minimum_coverage=.9 if confidence_unreported else .8
    result['status']='checked' if len(accepted)>=30 and coverage>=minimum_coverage else 'needs-review'
    if result['status']!='checked':result['reason']=f'Exact-word coverage {coverage:.1%} ({len(accepted)} of {len(interior)} spoken words in anchored passage), below {minimum_coverage:.0%} minimum'
    return result

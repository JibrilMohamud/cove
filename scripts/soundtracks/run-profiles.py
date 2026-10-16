#!/usr/bin/env python3
"""Bounded scheduled consumer; only Cove's already published exact masters are read."""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import tempfile
import time
import urllib.error
import urllib.request

ORIGIN='https://cove-puce-theta.vercel.app'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None
OPENER=urllib.request.build_opener(NoRedirect)

def audio_path(recording_id,value):
    if not re.fullmatch(r'(?:cm_[0-9]{1,15}|ex_[0-9a-f-]{36})',recording_id):raise ValueError('Invalid recording identity')
    expected='/api/fore/soundtracks/recordings/'+recording_id+'/audio'
    if value!=expected:raise ValueError('Untrusted audio URL')
    return ORIGIN+expected

def download(job,destination):
    url=audio_path(job['recordingId'],job['audioUrl'])
    size=job['bytes']
    if not isinstance(size,int) or not 0<size<=25*1024*1024:raise ValueError('Invalid master byte limit')
    digest=hashlib.sha1();count=0
    request=urllib.request.Request(url,headers={'User-Agent':'CoveMusicProfiles/1.0'})
    with OPENER.open(request,timeout=90) as response,open(destination,'wb') as out:
        if response.status!=200 or not response.headers.get('Content-Type','').startswith('audio/'):raise ValueError('Not an audio master')
        while chunk:=response.read(256*1024):
            count+=len(chunk)
            if count>size:raise ValueError('Oversized master')
            digest.update(chunk);out.write(chunk)
    if count!=size or digest.hexdigest()!=job['sourceSha1']:raise ValueError('Source checksum mismatch')

def api_call(path,body):
    token=os.environ.get('COVE_SOUNDTRACK_REVIEW_TOKEN','')
    if not token:raise ValueError('Scoped soundtrack review credential is required')
    if path not in ('claim','complete','fail','status','seed'):raise ValueError('Untrusted admin route')
    req=urllib.request.Request(ORIGIN+'/api/fore/admin/music-profiles/'+path,data=None if body is None else json.dumps(body,allow_nan=False).encode(),method='GET' if body is None else 'POST',headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','User-Agent':'CoveMusicProfiles/1.0'})
    with OPENER.open(req,timeout=120) as r:return json.load(r)

def queue_pending():
    status=api_call('status',None)
    jobs=status.get('jobs')
    if not isinstance(jobs,list):raise ValueError('Invalid queue status')
    for row in jobs:
        if not isinstance(row,dict) or row.get('status') not in ('queued','running','done','failed') or type(row.get('count')) is not int or row['count']<0:raise ValueError('Invalid queue counts')
    return any(row['status'] in ('queued','running') and row['count']>0 for row in jobs)

def run(max_tracks,max_minutes,output):
    call=api_call
    for attempt in range(30):
        try:
            call('status',None);break
        except urllib.error.HTTPError as error:
            if error.code not in (404,500,503) or attempt==29:raise
            time.sleep(10)
    call('seed',{})
    spec=importlib.util.spec_from_file_location('profile_audio',pathlib.Path(__file__).with_name('profile-audio.py'))
    analyzer=importlib.util.module_from_spec(spec);spec.loader.exec_module(analyzer)
    model=analyzer.AudioSemantics() # Load once before taking a lease; reuse text embeddings.
    started=time.monotonic();receipts=[]
    for _ in range(max_tracks):
        if time.monotonic()-started>max_minutes*60:break
        job=call('claim',{})
        if job.get('skipped'):break
        rid=job['recordingId']
        identity={k:job[k] for k in ('recordingId','fingerprint','leaseToken')}
        try:
            with tempfile.TemporaryDirectory(prefix='cove-profile-master-') as tmp:
                file=pathlib.Path(tmp)/'source.audio';download(job,file)
                report=analyzer.analyze(file,model)
            saved=call('complete',{**identity,'report':report})
            receipts.append({'recordingId':rid,'fingerprint':job['fingerprint'],'saved':saved['saved'],'durationSeconds':report['durationSeconds'],'semanticWindows':len(report['semantics']['windows'])})
            print(rid,'profiled',flush=True)
        except Exception as error:
            # Do not print credential-bearing Request objects or raw server bodies.
            message=type(error).__name__+': '+str(error)[:140]
            receipts.append({'recordingId':rid,'error':message})
            try:call('fail',{**identity,'error':message})
            except Exception:pass
            print(rid,'failed:',type(error).__name__,flush=True)
        pathlib.Path(output).write_text(json.dumps({'checkedAt':time.time(),'receipts':receipts},indent=2)+'\n')
    pathlib.Path(output).write_text(json.dumps({'checkedAt':time.time(),'receipts':receipts},indent=2)+'\n')
    return 1 if any('error' in r for r in receipts) else 0

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--max-tracks',type=int,default=40);p.add_argument('--max-minutes',type=int,default=24);p.add_argument('--output',default='music-profile-receipt.json');p.add_argument('--check-queue',action='store_true')
    a=p.parse_args()
    if a.check_queue:
        print('true' if queue_pending() else 'false');return 0
    if not 1<=a.max_tracks<=100 or not 1<=a.max_minutes<=30:p.error('Bounded track/time limits required')
    return run(a.max_tracks,a.max_minutes,a.output)
if __name__=='__main__':raise SystemExit(main())

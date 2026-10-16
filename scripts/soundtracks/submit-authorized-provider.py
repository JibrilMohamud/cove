#!/usr/bin/env python3
"""Submit separately authorized, QA-verified provider originals to Cove R2 staging.

No provider-site requests, no approvals, no unreviewed public access.
Only a separately authenticated human staff reviewer can publish these tracks.
"""
import argparse
import hashlib
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_FILE = 25 * 1024 * 1024
MAX_BATCH = 20

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

CLIENT = urllib.request.build_opener(NoRedirect)

def secure_origin(value):
    u=urllib.parse.urlsplit(value)
    if u.scheme!='https' or not u.hostname or u.username or u.password or u.port or u.path not in ('','/') or u.query or u.fragment:
        raise ValueError('Exact HTTPS Cove API origin is required')
    return value.rstrip('/')

def request(origin,token,path,method,data,content_type):
    headers={'Authorization':'Bearer '+token}
    if data is not None:
        headers['Content-Type']=content_type
    try:
        with CLIENT.open(urllib.request.Request(origin+'/api/fore'+path,data=data,method=method,headers=headers),timeout=90) as resp:
            return json.loads(resp.read(16_384))
    except urllib.error.HTTPError as e:
        raise RuntimeError('Cove stage endpoint rejected request (HTTP %s)' % e.code) from None

def convert(original,receipt):
    if not isinstance(receipt,dict) or receipt.get('status')!='qa_verified_staged':
        raise ValueError('File has no full-file FFmpeg QA pass')
    src=receipt.get('source') or {}
    for key,actual in (('provider',original.get('provider')),('sourcePageUrl',original.get('sourcePageUrl')),
                       ('sha1',original.get('sha1')),('sha256',original.get('sha256')),
                       ('bytes',original.get('bytes'))):
        if src.get(key)!=actual: raise ValueError('Receipt does not match exact source: '+key)
    q=receipt.get('quality')
    if not isinstance(q,dict) or q.get('sourceSha1')!=original.get('sha1') or q.get('sha256')!=original.get('sha256') or q.get('bytes')!=original.get('bytes'):
        raise ValueError('Audio QA describes a different file')
    data={k:v for k,v in original.items() if k!='file' and k!='id'}
    data['quality']=q
    code=original['licenseCode']
    data['licenseStatement']='Public domain (source-specific US claim)' if code=='PD' else code+' '+original['licenseUrl'].rstrip('/').split('/')[-1]
    return data

def run(manifest,receipts,audio_dir,origin,token,apply=False,max_tracks=MAX_BATCH):
    if not isinstance(manifest,dict) or manifest.get('schemaVersion')!=1:
        raise ValueError('A schema v1 manifest is required')
    if not isinstance(receipts,dict) or receipts.get('schemaVersion')!=1 or receipts.get('publishable') is not False:
        raise ValueError('Receipt must be an explicit non-publishable QA stage')
    items=manifest.get('recordings') or []
    if len(items)>max_tracks or len(items)>MAX_BATCH: raise ValueError('Batch exceeds 20 staged originals')
    mapped={r['id']:r for r in receipts.get('results',[]) if isinstance(r,dict) and isinstance(r.get('id'),str)}
    out=[]
    for original in items:
        key=str(original.get('id','?'))
        entry={'id':key,'status':'rejected'}
        try:
            supplied=convert(original,mapped.get(key))
            name=original.get('file')
            if not isinstance(name,str) or pathlib.Path(name).name!=name:
                raise ValueError('Original must be a flat file basename')
            path=audio_dir/name
            if path.is_symlink() or not path.is_file() or path.resolve().parent!=audio_dir.resolve():
                raise ValueError('Original escapes authorized delivery folder')
            contents=path.read_bytes()
            if not 0<len(contents)<=MAX_FILE or len(contents)!=original['bytes']:
                raise ValueError('Original byte limit or identity mismatch')
            if hashlib.sha1(contents).hexdigest()!=original['sha1'] or hashlib.sha256(contents).hexdigest()!=original['sha256']:
                raise ValueError('Original cryptographic digest mismatch')
            if apply:
                registered=request(origin,token,'/admin/soundtracks/external/register','POST',
                    json.dumps(supplied).encode(),'application/json')
                record_id=registered['id']
                if registered['status']=='ready':
                    raise ValueError('Already published master cannot be overwritten')
                staged=request(origin,token,'/admin/soundtracks/external/'+record_id+'/audio','PUT',
                    contents,original['mime'])
                if staged.get('status')!='staged': raise RuntimeError('Unexpected Cove staging response')
                entry.update(status='staged_private_r2',recordingId=record_id)
            else:
                entry.update(status='validated_preview',sha256=original['sha256'])
        except (KeyError,ValueError,OSError,RuntimeError) as error:
            entry['reason']=str(error)[:180]
        out.append(entry)
    return {'publishable':False,'applied':apply,'results':out,
            'summary':{'accepted':sum(x['status'] in ('staged_private_r2','validated_preview') for x in out),
                       'rejected':sum(x['status']=='rejected' for x in out)},
            'notice':'No public playback granted. Separate authorized human staff approval with MFA is mandatory.'}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest',type=pathlib.Path,required=True)
    p.add_argument('--receipt',type=pathlib.Path,required=True)
    p.add_argument('--audio-dir',type=pathlib.Path,required=True)
    p.add_argument('--origin',default=os.environ.get('COVE_SOUNDTRACK_API_ORIGIN',''))
    p.add_argument('--output',type=pathlib.Path,required=True)
    p.add_argument('--apply',action='store_true')
    args=p.parse_args()
    origin=secure_origin(args.origin) if args.apply else 'https://example.invalid'
    token=os.environ.get('COVE_SOUNDTRACK_REVIEW_TOKEN','')
    if args.apply and not token.startswith('fore_svc_'):
        p.error('A purpose-scoped Cove review token is required in the environment for apply')
    result=run(json.loads(args.manifest.read_text()),json.loads(args.receipt.read_text()),
               args.audio_dir,origin,token,args.apply)
    args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result['summary']))
    return bool(result['summary']['rejected'])

if __name__=='__main__':
    sys.exit(main())

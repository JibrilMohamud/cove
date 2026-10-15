#!/usr/bin/env python3
"""Submit a dossier batch through the versioned API; approvals require --approve-eligible.
Credentials are read from a private file and never printed. The API remains authoritative.
"""
import argparse,json,pathlib,urllib.request,urllib.error,urllib.parse

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--origin',required=True);p.add_argument('--token-file',required=True)
 p.add_argument('--approve-eligible',action='store_true');p.add_argument('--run-imports',action='store_true');p.add_argument('--output',required=True)
 p.add_argument('--dossiers',default='docs/soundtracks/pilot');p.add_argument('--quality-dir',default='docs/soundtracks/quality')
 p.add_argument('--source-reliance',action='store_true',help='Accept exact recording declarations; retain all known holds and QA gates')
 args=p.parse_args();origin=args.origin.rstrip('/')
 if not origin.startswith('https://'):p.error('An HTTPS Cove origin is required')
 parsed=urllib.parse.urlsplit(origin)
 if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:p.error('Use an HTTPS origin without credentials or a path')
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,req,fp,code,msg,headers,newurl):return None
 opener=urllib.request.build_opener(NoRedirect)
 token=pathlib.Path(args.token_file).read_text().strip();receipts=[]
 def call(path,method='GET',body=None):
  data=None if body is None else json.dumps(body).encode()
  req=urllib.request.Request(origin+'/api/fore'+path,data=data,method=method,
   headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','User-Agent':'CoveSoundtracksReview/0.3'})
  try:
   with opener.open(req,timeout=120) as r:return json.load(r)
  except urllib.error.HTTPError as e:raise RuntimeError(str(e.code)+' '+e.read(2000).decode()) from None
 for path in sorted(pathlib.Path(args.dossiers).glob('*.json')):
  dossier=json.loads(path.read_text());rid=dossier['recordingId'];base='/admin/soundtracks/recordings/'+rid
  try:
   current=call(base)['record']
   if current['status'] in ['ready','approved','importing']:
    print(rid,'already',current['status'],flush=True);receipts.append(dict(id=rid,status=current['status']));continue
   if current['status'] in ['rejected','revoked']:
    receipts.append(dict(id=rid,status=current['status'],skipped='Explicit withdrawal or rejection requires separate reassessment'));continue
   if args.source_reliance:
    saved=json.loads(current.get('dossier_json') or '{}');draft=dossier['dossier']
    draft['unresolved']=list(dict.fromkeys(saved.get('unresolved',[])+draft.get('unresolved',[])))
    draft['complexProvenance']=bool(saved.get('complexProvenance') or draft.get('complexProvenance'))
    draft['reviewMethod']='source_license'
    draft['sourceReliance']=dict(sourcePageUrl=current['source_page_url'],sourceSha1=current['source_sha1'],
     licenseCode=current['license_code'],licenseUrl=current['license_url'],
     declarationBasis='The operator accepts the repository recording declaration as the licensing basis under Cove source-reliance policy. No independent human or counsel clearance is asserted.')
    dossier['approval']['reviewEvidence']='Source-license reliance on the exact repository recording declaration, archived at approval. Dossier evidence and known holds are retained; no independent human or counsel clearance is asserted.'
   qpath=pathlib.Path(args.quality_dir)/path.name
   if not qpath.exists():raise ValueError('No measured audio report')
   qa=json.loads(qpath.read_text())
   for action,extra in [('draft',dict(dossier=dossier['dossier'])),('quality',dict(report=qa))]:
    result=call(base,'POST',dict(action=action,version=current['review_version'],**extra));current['review_version']=result['version']
   passed=-40<=qa['integratedLufs']<=-8 and qa['truePeakDbfs']<=0 and qa['clippedSampleRatio']<.001 and qa['silenceRatio']<.25
   if args.approve_eligible and passed and not dossier['dossier']['unresolved']:
    result=call(base,'POST',dict(action='approve',version=current['review_version'],**dossier['approval']))
    receipt=dict(id=rid,status='approved',decision=result)
   else:receipt=dict(id=rid,status='pending_review',quality='passed' if passed else 'failed',unresolved=dossier['dossier']['unresolved'])
   receipts.append(receipt);print(rid,receipt['status'],flush=True)
  except Exception as e:receipts.append(dict(id=rid,error=str(e)));print(rid,'ERROR',str(e),flush=True)
  pathlib.Path(args.output).write_text(json.dumps(receipts,indent=2)+'\n')
 if args.run_imports:
  for _ in range(len(receipts)):
   result=call('/admin/soundtracks/import-next','POST',{});print('IMPORT',json.dumps(result),flush=True)
   if result.get('skipped'):break
 pathlib.Path(args.output).write_text(json.dumps(receipts,indent=2)+'\n')
if __name__=='__main__':main()

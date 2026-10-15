#!/usr/bin/env python3
"""Build the reproducible candidate triage register without granting approvals."""
import csv,hashlib,json,pathlib
rows=json.load(open('docs/soundtrack-candidates-2026-10-15.json'))
fields=['id','title','license','claimed_creator','priority','disposition','source_revision','source_sha1','snapshot_sha256','source_page','permanent_url','pilot_dossier','quality_report','outstanding_questions']
with open('docs/soundtracks/REVIEW_REGISTER.csv','w',newline='') as f:
 writer=csv.DictWriter(f,fieldnames=fields);writer.writeheader()
 for row in rows:
  rid=row['id'];e=pathlib.Path('docs/soundtracks/evidence')/(rid+'.json');raw=e.read_bytes();d=json.loads(raw)
  pilot=pathlib.Path('docs/soundtracks/pilot')/(rid+'.json');qa=pathlib.Path('docs/soundtracks/quality')/(rid+'.json')
  license=row['license_code'];priority={'CC0':1,'CC-BY':2,'CC-BY-SA':3,'PD':4}[license]
  questions=['Composition, arrangement, lyrics, performance, master authority and territories require individual review.']
  disposition='research_required'
  if license=='PD':questions.append('Second independent review required for public-domain recording claims.')
  if pilot.exists():
   p=json.loads(pilot.read_text());questions=p['dossier']['unresolved'];disposition='pilot_research_complete'
  if qa.exists():
   q=json.loads(qa.read_text());passed=-40<=q['integratedLufs']<=-8 and q['truePeakDbfs']<=0 and q['clippedSampleRatio']<.001 and q['silenceRatio']<.25
   if not passed: questions=questions+['Measured audio QA failed; do not release the original file.'];disposition='audio_qa_failed'
  writer.writerow(dict(id=rid,title=row['title'],license=row['license_statement'],claimed_creator=row['performer'],priority=priority,
   disposition=disposition,source_revision=d['revisionId'],source_sha1=row['source_sha1'],snapshot_sha256=hashlib.sha256(raw).hexdigest(),
   source_page=row['source_page_url'],permanent_url=d['permanentUrl'],pilot_dossier=pilot.as_posix() if pilot.exists() else '',
   quality_report=qa.as_posix() if qa.exists() else '',outstanding_questions=' | '.join(questions)))
print('Built',len(rows),'source-specific triage entries. This register does not grant rights approval.')

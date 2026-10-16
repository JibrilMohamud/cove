#!/usr/bin/env python3
"""Bounded, fail-closed Commons source-license curation from Cove's review queue.

Measures original audio with FFmpeg, and submits versioned review decisions.
Source reliance is the owner's approved policy, never a claim of human clearance.
"""
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
import urllib.parse
import urllib.request

MAX_FILE_BYTES = 25 * 1024 * 1024
KNOWN_COMPOSERS = (
    (r"^(?:j\.?s\.?\s*)?bach\s+(?!busoni|brahms|liszt|gounod)", "Johann Sebastian Bach", "baroque"),
    (r"^johann sebastian bach[\s,-]", "Johann Sebastian Bach", "baroque"),
    (r"^(?:frederic|frédéric) chopin[\s,-]", "Frédéric Chopin", "romantic"),
    (r"^erik satie[\s,-]", "Erik Satie", "modern"),
    (r"^claude debussy[\s,-]", "Claude Debussy", "modern"),
    (r"^(?:georg )?muffat[\s,-]", "Georg Muffat", "baroque"),
    (r"^julius weissenborn[\s,-]", "Julius Weissenborn", "romantic"),
    (r"^bernhard romberg[\s,-]", "Bernhard Romberg", "classical"),
    (r"^alessandro poglietti[\s,-]", "Alessandro Poglietti", "baroque"),
    (r"^moritz moszkowsky[\s,-]", "Moritz Moszkowski", "romantic"),
    (r"^august klughardt[\s,-]", "August Klughardt", "romantic"),
    (r"^claude paul taffanel[\s,-]", "Claude Paul Taffanel", "romantic"),
    (r"^louis-emmanuel jadin[\s,-]", "Louis-Emmanuel Jadin", "classical"),
    (r"^(?:beethoven|ludwig van beethoven|beethoven, ludwig van)\s*[\s,-]", "Ludwig van Beethoven", "classical"),
    (r"^(?:mozart|wolfgang amadeus mozart|w\.?\s*a\.?\s*mozart)\s*[\s,-]", "Wolfgang Amadeus Mozart", "classical"),
    (r"^chopin\s+", "Frédéric Chopin", "romantic"),
    (r"^schubert\s+", "Franz Schubert", "romantic"),
    (r"^satie\s+", "Erik Satie", "modern"),
    (r"^debussy\s+", "Claude Debussy", "modern"),
    (r"^handel\s+", "George Frideric Handel", "baroque"),
    (r"^vivaldi\s+", "Antonio Vivaldi", "baroque"),
    (r"^haydn\s+", "Joseph Haydn", "classical"),
    (r"^pachelbel\s+", "Johann Pachelbel", "baroque"),
    (r"^(?:robert )?schumann\s*[\s,-]", "Robert Schumann", "romantic"),
    (r"^(?:johannes )?brahms\s*[\s,-]", "Johannes Brahms", "romantic"),
    (r"^(?:edvard )?grieg\s*[\s,-]", "Edvard Grieg", "romantic"),
    (r"^domenico zipoli\s*[\s,-]", "Domenico Zipoli", "baroque"),
    (r"^johann jakob froberger\s*[\s,-]", "Johann Jakob Froberger", "baroque"),
    (r"^giovanni battista pescetti\s*[\s,-]", "Giovanni Battista Pescetti", "baroque"),
    (r"^muzio clementi\s*[\s,-]", "Muzio Clementi", "classical"),
    (r"^(?:cesar|césar) franck\s*[\s,-]", "César Franck", "romantic"),
    (r"^(?:modest )?mussorgsky\s*[\s,-]", "Modest Mussorgsky", "romantic"),
    (r"^louis spohr\s*[\s,-]", "Louis Spohr", "romantic"),
    (r"^(?:maurice )?ravel\s*[\s,-]", "Maurice Ravel", "modern"),
    (r"^john dowland\s*[\s,-]", "John Dowland", "renaissance"),
    (r"^orlando gibbons\s*[\s(-]", "Orlando Gibbons", "renaissance"),
    (r"^john playford\s*[\s(-]", "John Playford", "baroque"),
    (r"^marin marais\s*[\s(-]", "Marin Marais", "baroque"),
    (r"^girolamo frescobaldi[\s,-]", "Girolamo Frescobaldi", "baroque"),
    (r"^wilhelm friedemann bach[\s,-]", "Wilhelm Friedemann Bach", "baroque"),
    (r"^johann joachim quantz[\s,-]", "Johann Joachim Quantz", "baroque"),
    (r"^adriano banchieri[\s,-]", "Adriano Banchieri", "renaissance"),
    (r"^giovanni picchi[\s,-]", "Giovanni Picchi", "renaissance"),
    (r"^caspar ferdinand fischer[\s,-]", "Johann Caspar Ferdinand Fischer", "baroque"),
    (r"^antonio de cabezon[\s,-]", "Antonio de Cabezón", "renaissance"),
    (r"^jean perrichon[\s,-]", "Jean Perrichon", "renaissance"),
    (r"^carl almenräder[\s,-]", "Carl Almenräder", "romantic"),
    (r"^david popper[\s,-]", "David Popper", "romantic"),
    (r"^antonio pasculli[\s,-]", "Antonio Pasculli", "romantic"),
    # Historical instrumental works with explicit composition attribution. Source
    # licensing and a distinct performer are still independently required below.
    (r"^johann jacob froberger[\s,-]", "Johann Jakob Froberger", "baroque"),
    (r"^jules demersseman[\s,-]", "Jules Demersseman", "romantic"),
    (r"^(?:heinrich )?scheidemann[\s,-]", "Heinrich Scheidemann", "baroque"),
    (r"^joachim andersen[\s,-]", "Joachim Andersen", "romantic"),
    (r"^(?:michel )?blavet[\s,-]", "Michel Blavet", "baroque"),
    (r"^benedetto marcello[\s,-]", "Benedetto Marcello", "baroque"),
    (r"^(?:carl maria von )?weber[\s,-]", "Carl Maria von Weber", "romantic"),
    (r"^paderewski[\s,-]", "Ignacy Jan Paderewski", "romantic"),
    (r"^scriabin[\s,-]", "Alexander Scriabin", "modern"),
    (r"^telemann\s+", "Georg Philipp Telemann", "baroque"),
    (r"^scarlatti\s+", "Domenico Scarlatti", "baroque"),
    (r"^couperin\s+", "François Couperin", "baroque"),
    (r"^rameau\s+", "Jean-Philippe Rameau", "baroque"),
)
# Filenames which state both the historical composer and the separately
# credited recording performer. We require the artist metadata to corroborate
# the title; a composer-only Artist field must not be mistaken for a performer.
NAMED_PERFORMER_TITLES = (
    (r"^schubert's impromptu .+ - chiara bertoglio$", "Franz Schubert", "romantic", "Chiara Bertoglio"),
    (r"^stefano ligoratti - haydn's keyboard sonata .+", "Joseph Haydn", "classical", "Stefano Ligoratti"),
    (r"^ivan ili[cć] - haydn's keyboard sonata .+", "Joseph Haydn", "classical", "Ivan Ilić"),
    (r"^marek kozak - haydn's keyboard sonata .+", "Joseph Haydn", "classical", "Marek Kozak"),
    (r"^studio konkon - handel's keyboard suite in g minor, hwv 432 - iii\. allegro \(piano\)$", "George Frideric Handel", "baroque", "Studio KonKon"),
)
COMPLEX = re.compile(r"(?i)\b(?:arr(?:anged|angement)?\.?|transcri(?:bed|ption)|remix|sampled|cover|busoni|brahms|liszt|gounod|adapted|orchestrated)\b")
AMBIGUOUS_CREDIT = re.compile(r"(?i)\b(?:unknown|unverified|composer|uploader|copyright|collection|archive|anonymous|various artists)\b")
ALLOWED_LICENSES = {"CC0", "CC-BY", "CC-BY-SA", "PD"}

# A bounded, record-specific artist/uploader correlation. Historical Boccherini
# compositions predate US copyright. Selected Commons file pages explicitly name
# Jacques Lochet as modern performer and User:Quinbrid as artist/rightsholder,
# and supply a CC BY-SA original-master declaration. This never extrapolates to
# unrelated tracks by that uploader or source pages lacking these exact claims.
BOCCHERINI_SELF_RELEASE = re.compile(
    r"^BOCCHERINI\s+Op[0-9]+\s*(?:n°[0-9]+|n°\s*[0-9]+|No[0-9]+|[0-9n°\s]*)?.*"
    r"\s+-\s+Jacques Lochet violin and (synthesizer|sampler)$", re.I
)
BOCCHERINI_RIGHTSHOLDER_CREDITS = frozenset((
    'Quinbrid', 'uploaded by artist: User:Quinbrid',
    'uploaded by artist User:Quinbrid',
))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

OPENER = urllib.request.build_opener(NoRedirect)

def secure_origin(origin):
    p = urllib.parse.urlsplit(origin)
    if p.scheme != 'https' or not p.hostname or p.username or p.password or p.port or p.path not in ('', '/') or p.query or p.fragment:
        raise ValueError('Review API origin must be an HTTPS hostname without a path, credentials or port')
    return origin.rstrip('/')

def trusted_media_url(value):
    """No untrusted media host, redirect, fragment, query, or SSRF."""
    p = urllib.parse.urlsplit(str(value))
    if (p.scheme != 'https' or p.hostname != 'upload.wikimedia.org' or p.port or p.username or p.password or p.fragment or
        not p.path.startswith('/wikipedia/commons/') or not re.search(r'\.(?:ogg|oga|mp3)$', p.path, re.I)):
        raise ValueError('Media URL is not a permitted original Commons upload')
    if any(not re.fullmatch(r'utm_[a-z0-9_]+', k, re.I) for k in urllib.parse.parse_qs(p.query)):
        raise ValueError('Unexpected media URL query parameters')
    return urllib.parse.urlunsplit((p.scheme, p.netloc, p.path, '', ''))

def credited_performer(value, composer):
    raw = str(value or '').strip()
    if re.search(r'(?i)\b(?:unknown|unverified|uploader|see above|copyright|various artists|anonymous|archive|assumed|metadata|see musopen|attribution|author provided|no machine-readable)\b', raw):
        return None
    # Wikimedia's Artist credit sometimes contains an explicit musician role.
    roles = re.findall(r'(?i)(?:musician|pianist|performer|played by|performed by)\s*:?\s*([^;()]+)', raw)
    credit = roles[-1].strip() if roles else raw
    credit = re.sub(r'(?i)\s*\((?:musician|performer|pianist)\)\s*', '', credit)
    credit = re.sub(r'(?i)^\s*(?:played by|performed by|musician|performer|pianist|pianists|recorded by)\s*:?\s*', '', credit)
    credit = credit.strip(' ,.;')
    # A composition credit alone is not an identifiable performer.
    if re.search(r'(?i)\b(?:composer|arranger|uploader|record label|orchestra unknown)\b', credit):
        return None
    if not 3 <= len(credit) <= 140 or '/' in credit or ';' in credit or len(credit.split()) > 9:
        return None
    if composer.lower() == credit.lower() or composer.lower() in credit.lower() or credit.lower() in composer.lower() or re.search(r'(?i)https?://|www\.', credit):
        return None
    if not re.search(r'[A-Za-zÀ-ž]{2,}', credit) or re.fullmatch(r'\w+\d+', credit):
        return None
    return credit

INSTRUMENT_CUES = ('piano','harpsichord','organ','violin','cello','flute','oboe',
                   'clarinet','bassoon','guitar','trumpet','harp','viola','recorder',
                   'mandolin','saxophone','percussion')
VOCAL_CUES = re.compile(r'(?i)\b(?:aria|lied|lieder|song|singer|vocal|choir|choral|soprano|tenor|baritone|hymn|mass|cantata|motet|opera|recitative)\b')

def classify_instruments(row):
    original = json.loads(row.get('instruments_json') or '[]')
    if original == ['piano']:
        return original
    source = (str(row.get('title') or '')+' '+str(row.get('performer') or '')).lower()
    cues = [name for name in INSTRUMENT_CUES if re.search(r'\b'+name+r'\b', source)]
    # Never assign a made-up instrument when the source does not identify one.
    return cues[:5] if cues else ['unspecified']

def choose_candidate(r):
    if r.get('status') != 'pending_review' or r.get('quality_status') != 'pending':
        return None, 'previously reviewed or quality checked'
    if r.get('dossier_json') not in ('{}', '', None):
        return None, 'pre-existing dossier; preserve review work and holds'
    if r.get('license_code') not in ALLOWED_LICENSES:
        return None, 'ineligible license'
    license_link = str(r.get('license_url') or '')
    if r['license_code']=='CC0' and license_link!='https://creativecommons.org/publicdomain/zero/1.0/':
        return None, 'mismatched CC0 declaration'
    if r['license_code'] in ('CC-BY', 'CC-BY-SA'):
        slug='by-sa' if r['license_code']=='CC-BY-SA' else 'by'
        if not re.fullmatch(r'https://creativecommons\.org/licenses/'+slug+r'/[234](?:\.0|\.5)/',license_link):
            return None, 'unsupported or mismatched CC license'
    if r['license_code']=='PD' and license_link!='https://commons.wikimedia.org/wiki/Commons:Licensing':
        return None, 'unrecognized PD claim link'
    title = str(r.get('title', ''))
    if not str(r.get('source_title','')).startswith('File:') or COMPLEX.search(title) or '-' in title.split(' ', 1)[0]:
        return None, 'arrangement or derivative provenance requires individual review'
    boccherini = BOCCHERINI_SELF_RELEASE.fullmatch(title) if (
        r['license_code'] == 'CC-BY-SA' and
        str(r.get('performer', '')).strip() in BOCCHERINI_RIGHTSHOLDER_CREDITS and
        str(r.get('source_title', '')) == 'File:'+title+'.ogg'
    ) else None
    match = next(((composer, period) for pattern, composer, period in KNOWN_COMPOSERS if re.search(pattern, title, re.I)), None)
    if not match and boccherini:
        match = ("Luigi Boccherini", "classical")
    if not match:
        named = next(((composer, period, person) for pattern, composer, period, person in NAMED_PERFORMER_TITLES
                      if re.fullmatch(pattern, title, re.I)), None)
        if named:
            composer, period, person = named
            credited = credited_performer(r.get('performer'), composer)
            if credited and credited.casefold() == person.casefold():
                match = (composer, period)
    if not match:
        return None, 'composer not in narrow sourced-title mapping'
    composer, period = match
    performer = "Jacques Lochet" if boccherini else credited_performer(r.get('performer'), composer)
    if not performer:
        return None, 'ambiguous or missing performer credit'
    if (not re.fullmatch(r'cm_\d{1,15}', str(r.get('id', ''))) or
        not re.fullmatch(r'[a-f0-9]{40}', str(r.get('source_sha1', ''))) or
        not isinstance(r.get('source_size'), int) or not 1 <= r['source_size'] <= MAX_FILE_BYTES):
        return None, 'missing immutable source identity'
    source_page = urllib.parse.urlsplit(str(r.get('source_page_url', '')))
    if source_page.scheme != 'https' or source_page.hostname != 'commons.wikimedia.org' or not source_page.path.startswith('/wiki/'):
        return None, 'untrusted source page'
    try:
        trusted_media_url(r.get('source_file_url'))
    except ValueError:
        return None, 'untrusted media URL'
    instrument_list = json.loads(r.get('instruments_json') or '[]')
    if VOCAL_CUES.search(title):
        return None, 'vocal composition requires a separate lyrics and performance review'
    instrument_list = classify_instruments(r)
    lo = title.lower()
    if re.search(r'nocturne|adagio|lento|andante|prelude|sinfonien|sonata', lo):
        moods, energy = ['reflective', 'gentle'], 0.3
    elif re.search(r'allegro|presto|vivace|toccata|scherzo|march', lo):
        moods, energy = ['animated', 'dramatic'], 0.8
    else:
        moods, energy = ['focused', 'contemplative'], 0.4
    if boccherini:
        instrument_list = ['violin', boccherini.group(1).lower()]
    return dict(composer=composer, period=period, performer=performer,
                sourceLicensor='Quinbrid' if boccherini else '',
                instruments=instrument_list, moods=moods, energy=energy), ''

def prepare_release(r, profile):
    page, link, code, sha = (r[k] for k in ('source_page_url', 'license_url', 'license_code', 'source_sha1'))
    exact = f"{page} (original recording; SHA-1 {sha}); {link}"
    def layer(claim):
        return dict(basis=claim + ' Source-declaration reliance only; independently unverified. Original, unchanged audio will be used.', evidenceUrls=[page, link])
    title = r['title']
    licensor = f" Commons original-master licensor: {profile['sourceLicensor']}." if profile.get('sourceLicensor') else ""
    credit = f"{title} — performed by {profile['performer']}; composed by {profile['composer']}.{licensor} {r['license_statement']}. {exact}. Unmodified original recording."
    statement = f"Cove accepts the exact recording-level {r['license_statement']} declaration of this Commons file under the owner-approved source reliance policy. This is not a human or independent legal assessment."
    dossier = dict(
        composition=layer(f"The source filename identifies {profile['composer']} as composer; the recorded composition is covered only to the extent of the file's exact declared permission."),
        arrangement=layer('No third-party arranger is named in the short source metadata used for automatic selection; unclear derivative titles are excluded.'),
        lyrics=layer('The source has no identified vocal indicators in its title. Vocal or lyrical works are excluded from this automated path; rights remain based on the exact source license.'),
        performance=layer(f"The modern performer is {profile['performer']}; "
                          + (f"the exact source title identifies him while Commons uploader {profile['sourceLicensor']} asserts the source file's CC BY-SA rights. " if profile.get('sourceLicensor') else
                             "Cove relies on the recording-level source declaration for performance permissions. ")),
        master=layer('The recording-level permission is attached to the exact source file and immutable SHA-1; the master will not be altered.'),
        grantingParty='Wikimedia Commons source declarant (identity not independently verified)',
        recordingDate='Undated; recording date not established by source metadata',
        territoryBasis='Initial distribution restricted to the United States under Cove recording-level source reliance; no global public-domain conclusion is made.',
        streamingBasis='The exact original recording is made available without DRM or transcoding. The declared license is relied upon for commercial copying and streaming, subject to credit, ShareAlike when applicable, and rights withdrawal.',
        attributionText=credit,
        modificationNotice='Original source file distributed unchanged; no modifications by Cove.',
        reviewMethod='source_license',
        sourceReliance=dict(sourcePageUrl=page,sourceSha1=sha,licenseCode=code,licenseUrl=link,
                            declarationBasis=statement + ' Any known conflicts or changes block automatic approval.'),
        complexProvenance=False,unresolved=[])
    approval = dict(
        reviewer='COVE-SOURCE-AUTOMATION',reviewEvidence=statement + ' Audio decode and identity must pass measured QA. Composition, recording, and performance declarations are accepted from the exact repository record; this is not a human attestation.',
        composer=profile['composer'],performer=profile['performer'],period=profile['period'],
        instruments=profile['instruments'],moods=profile['moods'],energy=profile['energy'],hasVocals=False,
        territories=['US'],compositionRightsConfirmed=True,performanceRightsConfirmed=True,
        attributionReviewed=True,title=title)
    return dossier, approval

def download_original(r, destination, opener=OPENER):
    url = trusted_media_url(r['source_file_url'])
    size = r['source_size']
    digest = hashlib.sha1()
    count = 0
    req = urllib.request.Request(url, headers={'User-Agent':'CoveSoundtracksCuration/1.0 (https://cove-puce-theta.vercel.app/help)','Accept':'audio/*'})
    with opener.open(req, timeout=45) as source, open(destination, 'wb') as sink:
        if source.status != 200:
            raise ValueError('Original media must return HTTP 200 without redirects')
        length = source.headers.get('Content-Length')
        if length and (not length.isdecimal() or int(length) != size):
            raise ValueError('Declared content length does not match source identity')
        while block := source.read(min(1024*1024, size-count+1)):
            count += len(block)
            if count > size or count > MAX_FILE_BYTES:
                raise ValueError('Unexpected oversized audio response')
            digest.update(block)
            sink.write(block)
    if count != size or digest.hexdigest() != r['source_sha1']:
        raise ValueError('Source file size or SHA-1 changed; do not submit QA or approve')

class CoveReviewClient:
    def __init__(self, origin, token, opener=OPENER):
        self.origin = secure_origin(origin)
        if not token or '\n' in token:
            raise ValueError('A scoped soundtrack review credential is required')
        self.token = token
        self.opener = opener

    def call(self, path, body=None):
        if not path.startswith('/admin/soundtracks'):
            raise ValueError('Invalid review API path')
        url = self.origin+'/api/fore'+path
        data = None if body is None else json.dumps(body).encode('utf-8')
        req = urllib.request.Request(url, data=data, method='POST' if body is not None else 'GET',
                    headers={'Authorization': 'Bearer '+self.token,'Content-Type':'application/json',
                             'User-Agent':'CoveSoundtracksCuration/1.0'})
        # Only idempotent reads can be retried. Never replay a write after an
        # ambiguous 503 response: review versions protect correctness, not
        # side-effect-free replay of provider/storage operations.
        attempts = 4 if body is None else 1
        for attempt in range(attempts):
            try:
                with self.opener.open(req, timeout=45) as response:
                    if response.status != 200:
                        raise ValueError('Unexpected Cove API response')
                    return json.load(response)
            except urllib.error.HTTPError as exc:
                if body is None and exc.code in (429, 502, 503, 504) and attempt + 1 < attempts:
                    time.sleep(min(2 ** attempt, 4))
                    continue
                raise RuntimeError(f'Cove review API returned HTTP {exc.code}') from None

def run(args, client, measure):
    receipts = []
    seen = set()
    examined = 0
    cursor = ''
    start = time.monotonic()
    processed = 0
    triaged = 0
    bytes_total = 0
    while examined < args.max_scan and processed < args.max_tracks and bytes_total < args.max_mib * 1024 * 1024:
        page_size = min(100, args.max_scan-examined)
        mode = 'triaged' if getattr(args,'reconsider_triaged',False) else '1'
        page = client.call('/admin/soundtracks?status=pending_review&automation='+mode+'&limit='+str(page_size)+'&after='+urllib.parse.quote(cursor))
        records = page.get('records', [])
        if not isinstance(records, list) or not records: break
        for row in records:
            examined += 1
            rid = row.get('id', '')
            if rid in seen: raise RuntimeError('Pagination loop detected')
            seen.add(rid)
            profile, reason = choose_candidate(row)
            if not profile:
                if reason not in ('previously reviewed or quality checked',
                                  'pre-existing dossier; preserve review work and holds') and triaged < getattr(args,'max_triage',0):
                    triaged += 1
                    if not args.apply:
                        receipts.append(dict(id=rid,status='manual_review_dry_run',reason=reason))
                    else:
                        try:
                            detail = client.call('/admin/soundtracks/recordings/'+rid)['record']
                            again, reason2 = choose_candidate(detail)
                            if not again and reason2 not in ('previously reviewed or quality checked',
                                     'pre-existing dossier; preserve review work and holds'):
                                explanation = ('Not eligible for machine approval; original retained for staff rights review. '
                                               + reason2)
                                client.call('/admin/soundtracks/recordings/'+rid,
                                            dict(action='triage',version=detail['review_version'],reason=explanation))
                                receipts.append(dict(id=rid,status='requires_manual_review',reason=reason2))
                        except (RuntimeError,ValueError,KeyError,urllib.error.URLError) as error:
                            receipts.append(dict(id=rid,status='triage_error',kind=type(error).__name__))
                continue
            if bytes_total + row['source_size'] > args.max_mib * 1024 * 1024:
                receipts.append(dict(id=rid,status='deferred',reason='byte budget'))
                continue
            if processed >= args.max_tracks: break
            processed += 1
            bytes_total += row['source_size']
            if not args.apply:
                receipts.append(dict(id=rid,status='eligible_dry_run',bytes=row['source_size'],composer=profile['composer']))
                continue
            try:
                detail = client.call('/admin/soundtracks/recordings/'+rid)['record']
                profile, reason = choose_candidate(detail)
                if not profile:
                    receipts.append(dict(id=rid,status='held',reason=reason))
                    continue
                with tempfile.TemporaryDirectory(prefix='cove-audio-') as directory:
                    suffix='.mp3' if detail['mime']=='audio/mpeg' else '.ogg'
                    audio_path=pathlib.Path(directory)/('recording'+suffix)
                    download_original(detail,audio_path)
                    report=measure(audio_path)
                if (report['sourceSha1'] != detail['source_sha1'] or report['bytes'] != detail['source_size']):
                    raise ValueError('Audio analysis returned a different file identity')
                dossier, approval = prepare_release(detail, profile)
                version = detail['review_version']
                result = client.call('/admin/soundtracks/recordings/'+rid,dict(action='quality',version=version,report=report))
                version = result['version']
                quality_pass = (-40 <= report['integratedLufs'] <= -8 and report['truePeakDbfs'] <= 0 and
                    report['clippedSampleRatio'] < 0.001 and report['silenceRatio'] < .25)
                if not quality_pass:
                    receipts.append(dict(id=rid,status='held_audio_qa',bytes=report['bytes']))
                    continue
                result = client.call('/admin/soundtracks/recordings/'+rid,dict(action='draft',version=version,dossier=dossier))
                if args.approve_source_license:
                    client.call('/admin/soundtracks/recordings/'+rid,dict(action='approve',version=result['version'],**approval))
                    receipts.append(dict(id=rid,status='approved_awaiting_storage',bytes=report['bytes']))
                else:
                    receipts.append(dict(id=rid,status='measured_draft',bytes=report['bytes']))
            except (OSError, ValueError, RuntimeError, KeyError, urllib.error.URLError) as error:
                receipts.append(dict(id=rid,status='error',kind=type(error).__name__,message=str(error)[:160] if isinstance(error, ValueError) else 'operation failed'))
            if time.monotonic()-start > args.max_minutes * 60:
                receipts.append(dict(status='time_budget_exhausted'))
                return receipts
        if not page.get('nextCursor') or page['nextCursor']==cursor: break
        cursor=page['nextCursor']
    return receipts

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--origin',default='https://cove-puce-theta.vercel.app')
    p.add_argument('--reconsider-triaged',action='store_true',
                   help='Review only previously triaged candidates after source policy expands; never bypass license/QA gates')
    p.add_argument('--max-scan',type=int,default=800)
    p.add_argument('--max-tracks',type=int,default=8)
    p.add_argument('--max-triage',type=int,default=60)
    p.add_argument('--max-mib',type=int,default=160)
    p.add_argument('--max-minutes',type=int,default=20)
    p.add_argument('--apply',action='store_true',help='Upload measured QA and dossier to production')
    p.add_argument('--approve-source-license',action='store_true',help='Requires --apply; permit eligible exact-file source reliance approvals')
    p.add_argument('--output',default='soundtrack-curation-receipts.json')
    args=p.parse_args()
    if not 1<=args.max_scan<=800 or not 1<=args.max_tracks<=12 or not 0<=args.max_triage<=100 or not 1<=args.max_mib<=160 or not 1<=args.max_minutes<=25:
        p.error('Bounded scan, track, byte, and wall-time budgets required')
    if args.approve_source_license and not args.apply:
        p.error('--approve-source-license requires --apply')
    token = os.environ.get('COVE_SOUNDTRACK_REVIEW_TOKEN','')
    if not token:
        p.error('COVE_SOUNDTRACK_REVIEW_TOKEN must be configured as a scoped Actions secret')
    spec=importlib.util.spec_from_file_location('cove_audio_measure',pathlib.Path(__file__).with_name('measure-audio.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    receipts = run(args,CoveReviewClient(args.origin,token),module.measure)
    pathlib.Path(args.output).write_text(json.dumps({'mode':'source_license' if args.approve_source_license else 'draft' if args.apply else 'dry_run','records':receipts},indent=2)+'\n')
    statuses={}
    for r in receipts: statuses[r['status']]=statuses.get(r['status'],0)+1
    print(json.dumps({'examinedLimit':args.max_scan,'statuses':statuses,'receipt':args.output}))
    if any(r['status']=='error' for r in receipts):
        raise SystemExit('Some candidate operations failed; see receipt for non-secret error codes')
if __name__=='__main__':main()

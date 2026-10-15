#!/usr/bin/env python3
"""Measure a local, exact-source recording. This never approves rights or uploads media."""
import argparse, datetime, hashlib, json, pathlib, re, subprocess

def measure(file):
    path = pathlib.Path(file)
    hashes = {name: hashlib.new(name) for name in ('sha1','sha256')}
    with path.open('rb') as stream:
        while chunk := stream.read(1024*1024):
            for digest in hashes.values(): digest.update(chunk)
    probe = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(path)]))
    audio = [s for s in probe['streams'] if s['codec_type']=='audio']
    if len(audio)!=1: raise ValueError('Exactly one audio stream is required')
    track = audio[0]; duration = float(probe['format']['duration'])
    result = subprocess.run(['ffmpeg','-nostdin','-hide_banner','-v','info','-xerror','-i',str(path),
        '-map','0:a:0','-af','ebur128=peak=true,astats=metadata=0:reset=0,silencedetect=noise=-50dB:d=1',
        '-f','null','-'],capture_output=True,text=True,timeout=600)
    if result.returncode: raise RuntimeError(result.stderr[-2500:])
    log = result.stderr
    def last(pattern):
        matches = re.findall(pattern, log)
        if not matches: raise ValueError('Measurement not found: '+pattern)
        return float(matches[-1])
    lufs = last(r'I:\s+(-?[\d.]+) LUFS')
    peak = last(r'Peak:\s+(-?[\d.]+) dBFS')
    sample_peak = last(r'Peak level dB:\s+(-?[\d.]+)')
    peak_count = last(r'Peak count:\s+([\d.]+)')
    samples = last(r'Number of samples:\s+([\d.]+)')
    silence = sum(float(v) for v in re.findall(r'silence_duration: ([\d.]+)',log))
    starts = re.findall(r'silence_start: ([\d.]+)',log)
    ends = re.findall(r'silence_end: ([\d.]+)',log)
    if len(starts)>len(ends): silence += max(0,duration-float(starts[-1]))
    return dict(sourceSha1=hashes['sha1'].hexdigest(),sha256=hashes['sha256'].hexdigest(),bytes=path.stat().st_size,
                durationSeconds=duration,channels=int(track['channels']),sampleRate=int(track['sample_rate']),
                integratedLufs=lufs,truePeakDbfs=peak,silenceRatio=min(1,silence/duration),
                clippedSampleRatio=peak_count/samples if sample_peak>=0 else 0,decodedFully=True,
                tool=subprocess.check_output(['ffmpeg','-version'],text=True).splitlines()[0],
                measuredAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('file');p.add_argument('--output',required=True)
    a=p.parse_args();report=measure(a.file);pathlib.Path(a.output).write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))
if __name__=='__main__': main()

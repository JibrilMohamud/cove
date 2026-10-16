#!/usr/bin/env python3
"""Exact-master DSP over the full recording plus optional pinned CLAP audio inference.

No composer, title, dates, filenames, catalog moods or provider metadata enter CLAP.
No rights decisions or recording modifications are made by this analyzer.
"""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import math
import pathlib
import subprocess
import tempfile
import numpy as np
from scipy import signal

POLICY='cove-music-v1'
MODEL='laion/clap-htsat-unfused'
REVISION='8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a'
RATE=16000
GROUPS={
 'moods':['serene','wistful','warm','playful','tense','menacing','majestic','melancholic','solemn','romantic','brooding','heroic'],
 'nuance':['delicate and fragile','slightly uncanny','restrained and introspective','dark and claustrophobic','luminous and spacious','ceremonial and dignified','tender and intimate','restless and agitated'],
 'valence':['sad and sorrowful','joyful and cheerful'],
 'arousal':['calm and low intensity','excited and high intensity'],
 'acousticness':['electronic synthesized music','acoustic instrumental music'],
 'vocalPresence':['instrumental music without voices','music with singing or spoken voices'],
 'ensembleSize':['solo instrument','small chamber ensemble','large orchestra'],
 'scale':['intimate small room performance','grand expansive performance'],
 'texture':['sustained legato','short staccato notes','sparse open texture','dense layered texture','flowing arpeggios','droning sustained tones'],
 'instruments':['piano','organ','harp','lyre','guitar','violin','cello','flute','oboe','clarinet','bassoon','brass','percussion','voice'],
}

def unit(x): return round(float(np.clip(x,0,1)),6)
def finite(x,default=0): return float(x) if math.isfinite(float(x)) else default

def model_windows(duration):
    # Uniform coverage includes the ending; windows never overlap or exceed duration.
    count=min(8,max(1,math.ceil(duration/10)))
    width=min(10.0,duration/count)
    return [(float(start),min(duration,float(start)+width)) for start in np.linspace(0,max(0,duration-width),count)]

class AudioSemantics:
    def __init__(self):
        import torch
        from transformers import ClapModel,ClapProcessor
        self.torch=torch
        torch.set_num_threads(2)
        self.processor=ClapProcessor.from_pretrained(MODEL,revision=REVISION,trust_remote_code=False)
        self.model=ClapModel.from_pretrained(MODEL,revision=REVISION,trust_remote_code=False).eval()
        self.labels=list(dict.fromkeys(label for values in GROUPS.values() for label in values))
        encoded=self.processor(text=['The sound of '+label+' music.' for label in self.labels],return_tensors='pt',padding=True)
        with torch.inference_mode(): self.text=self.model.get_text_features(**encoded)
        if not isinstance(self.text,torch.Tensor): self.text=self.text.pooler_output
        self.text=torch.nn.functional.normalize(self.text,dim=-1)
    def analyze(self,file,duration):
        t=self.torch
        windows=model_windows(duration)
        scores=[]
        for start,end in windows:
            raw=subprocess.check_output(['ffmpeg','-nostdin','-v','error','-ss',str(start),'-i',str(file),'-t',str(end-start),'-map','0:a:0','-ac','1','-ar','48000','-f','f32le','-'],timeout=90)
            pcm=np.frombuffer(raw,dtype='<f4').copy()
            encoded=self.processor(audios=pcm,sampling_rate=48000,return_tensors='pt',padding=True)
            with t.inference_mode(): audio=self.model.get_audio_features(**encoded)
            if not isinstance(audio,t.Tensor): audio=audio.pooler_output
            audio=t.nn.functional.normalize(audio,dim=-1)
            scores.append((audio@self.text.T).detach().cpu().numpy()[0])
        averages=np.mean(scores,axis=0)
        index={label:float(averages[i]) for i,label in enumerate(self.labels)}
        def ranked(group): return sorted(GROUPS[group],key=lambda x:-index[x])
        def choose(group,margin=.015):
            labels=ranked(group)
            return labels[0] if index[labels[0]]>=.18 and index[labels[0]]-index[labels[1]]>=margin else None
        def dimension(group):
            a,b=GROUPS[group]
            # A bounded similarity contrast, NOT an emotion probability.
            if max(index[a],index[b])<.18 or abs(index[b]-index[a])<.015:return None
            return unit(.5+2.5*(index[b]-index[a]))
        ensemble=choose('ensembleSize'); scale=choose('scale')
        return dict(model=MODEL,revision=REVISION,method='zero_shot_audio_text_similarity',scoreMeaning='uncalibrated_cosine_similarity',
            sampledSeconds=sum(end-start for start,end in windows),windows=[dict(start=s,end=e) for s,e in windows],
            moods=[dict(label=label,similarity=round(index[label],6)) for label in ranked('moods')[:5] if index[label]>=.18],
            nuance=[label for label in ranked('nuance')[:3] if index[label]>=.18],
            dimensions=dict(valence=dimension('valence'),arousal=dimension('arousal'),acousticness=dimension('acousticness'),vocalPresence=dimension('vocalPresence'),
                ensembleSize={'solo instrument':'solo','small chamber ensemble':'chamber','large orchestra':'orchestra'}.get(ensemble,'unknown'),
                scale={'intimate small room performance':'intimate','grand expansive performance':'grand'}.get(scale,'unknown'),
                texture=[label for label in ranked('texture')[:3] if index[label]>=.18],instruments=[label for label in ranked('instruments')[:3] if index[label]>=.22]),confidence=.6)

def analyze(file,semantic_model=None):
    file=pathlib.Path(file)
    if not file.is_file() or file.stat().st_size>25*1024*1024:raise ValueError('Audio master exceeds byte limit')
    spec=importlib.util.spec_from_file_location('measure',pathlib.Path(__file__).with_name('measure-audio.py'))
    measure=importlib.util.module_from_spec(spec);spec.loader.exec_module(measure)
    probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_format','-of','json',str(file)],timeout=30))
    if not 0<float(probe['format']['duration'])<=7200:raise ValueError('Audio duration exceeds analysis limit')
    qa=measure.measure(file)
    duration=qa['durationSeconds']
    timeline=[];onset_times=[];all_rms=[];centroids=[];rolloffs=[];flats=[];crossings=[];chroma=np.zeros(12)
    with tempfile.TemporaryDirectory(prefix='cove-audio-dsp-') as tmp:
        pcm=pathlib.Path(tmp)/'mono.f32'
        subprocess.run(['ffmpeg','-nostdin','-v','error','-xerror','-i',str(file),'-map','0:a:0','-ac','1','-ar',str(RATE),'-f','f32le',str(pcm)],check=True,timeout=600)
        if pcm.stat().st_size>RATE*4*7201:raise ValueError('Decoded duration exceeds bound')
        x=np.memmap(pcm,dtype='<f4',mode='r')
        measured_duration=len(x)/RATE
        if abs(duration-measured_duration)>.5:raise ValueError('Container and decoded duration disagree')
        # Equal bins cover every decoded sample, with FFT work bounded to one bin.
        bin_seconds=max(5.0,math.ceil(duration/1440))
        frequencies=np.fft.rfftfreq(1024,1/RATE)
        midi=np.rint(69+12*np.log2(np.maximum(frequencies,1)/440)).astype(int)%12
        for start in np.arange(0,duration,bin_seconds):
            end=min(duration,start+bin_seconds)
            piece=np.array(x[int(start*RATE):min(len(x),int(end*RATE))],dtype=np.float64)
            if not len(piece):piece=np.zeros(1)
            _,times,z=signal.stft(piece,fs=RATE,nperseg=min(1024,len(piece)),noverlap=min(768,max(0,len(piece)-1)),boundary='zeros')
            magnitude=np.abs(z)
            if len(piece)<1024:
                frequencies=np.linspace(0,RATE/2,magnitude.shape[0]);midi=np.rint(69+12*np.log2(np.maximum(frequencies,1)/440)).astype(int)%12
            power=magnitude*magnitude;mass=np.sum(power,axis=0)+1e-20
            center=np.sum(power*frequencies[:,None],axis=0)/mass
            cumulative=np.cumsum(power,axis=0)
            roll=frequencies[np.argmax(cumulative>=.85*mass,axis=0)]
            flat=np.exp(np.mean(np.log(power+1e-20),axis=0))/(np.mean(power,axis=0)+1e-20)
            normalized=magnitude/(np.sum(magnitude,axis=0,keepdims=True)+1e-12)
            flux=np.sum(np.maximum(0,np.diff(normalized,axis=1)),axis=0)
            threshold=np.median(flux)+1.5*np.std(flux)
            peaks,_=signal.find_peaks(flux,height=max(.04,threshold),distance=6)
            onset_times.extend((start+times[np.minimum(peaks+1,len(times)-1)]).tolist())
            for pitch in range(12):chroma[pitch]+=np.sum(power[midi==pitch])
            rms=20*np.log10(max(1e-7,float(np.sqrt(np.mean(piece**2)))))
            timeline.append(dict(start=round(float(start),4),end=round(float(end),4),rmsDbfs=round(max(-140,rms),4),centroidHz=round(float(np.mean(center)),4),onsets=int(len(peaks))))
            all_rms.append(rms);centroids.append(float(np.mean(center)));rolloffs.append(float(np.mean(roll)));flats.append(float(np.mean(flat)));crossings.append(float(np.mean(np.diff(np.signbit(piece)))))
        del x
    rms=np.asarray(all_rms);q10,q90=np.percentile(rms,[10,90]);dynamic=max(0,float(q90-q10))
    def intervals(predicate):
        result=[]
        for b in timeline:
            if predicate(b):
                if result and abs(result[-1][1]-b['start'])<.1:result[-1][1]=b['end']
                else:result.append([b['start'],b['end']])
        return result[:64]
    # Exclude uniform tones/silence from tempo claims. Tempo is an onset estimate.
    onset_rate=len(onset_times)/max(duration,1)
    tempo=None;tempo_conf=0
    if len(onset_times)>=12:
        histogram,_=np.histogram(onset_times,bins=np.arange(0,duration+.1,.05))
        ac=signal.fftconvolve(histogram,histogram[::-1],mode='full')[len(histogram)-1:]
        lo,hi=6,min(41,len(ac))
        if hi>lo:
            lag=lo+int(np.argmax(ac[lo:hi]));tempo_conf=unit(ac[lag]/max(ac[0],1))
            if tempo_conf>=.18:tempo=round(1200/lag,2)
    normalized=chroma/max(float(np.sum(chroma)),1e-20)
    entropy=unit(-np.sum(normalized*np.log(normalized+1e-20))/np.log(12))
    abrupt=unit(np.mean(np.abs(np.diff(rms))>6)) if len(rms)>1 else 0
    transitions=[b['start'] for b in timeline[1:-1] if b['rmsDbfs']<q10+1][:64]
    transitions=[t for i,t in enumerate(transitions) if i==0 or t-transitions[i-1]>=10]
    semantics=semantic_model.analyze(file,duration) if semantic_model else None
    # ebur128 LRA is from the exact original, not the low-rate analysis derivative.
    loudness=subprocess.run(['ffmpeg','-nostdin','-v','info','-i',str(file),'-af','ebur128=peak=true','-f','null','-'],capture_output=True,text=True,timeout=600)
    if loudness.returncode:raise ValueError('Loudness analysis failed')
    import re
    lra=re.findall(r'LRA:\s+([\d.]+) LU',loudness.stderr)
    return dict(policy=POLICY,sourceSha1=qa['sourceSha1'],sha256=qa['sha256'],bytes=qa['bytes'],durationSeconds=duration,decodedFully=True,
        analyzer='cove-dsp-v1; '+qa['tool'],measuredAt=dt.datetime.now(dt.timezone.utc).isoformat(),
        loudness=dict(integratedLufs=qa['integratedLufs'],truePeakDbfs=qa['truePeakDbfs'],loudnessRangeLu=float(lra[-1]) if lra else 0,rmsDynamicRangeDb=round(dynamic,4)),
        signal=dict(spectralCentroidHz=float(np.mean(centroids)),spectralRolloffHz=float(np.mean(rolloffs)),spectralFlatness=unit(np.mean(flats)),zeroCrossingRate=unit(np.mean(crossings)),onsetsPerSecond=round(onset_rate,6),tempoBpm=tempo,tempoConfidence=tempo_conf,tonalEntropy=entropy,abruptTransitionRate=abrupt,rhythmicActivity=unit(onset_rate/4),energy=unit(.5*np.clip((qa['integratedLufs']+40)/32,0,1)+.5*np.clip(onset_rate/4,0,1))),
        structure=dict(binSeconds=bin_seconds,timeline=timeline,quietSections=intervals(lambda b:b['rmsDbfs']<q10+1 and dynamic>3),climaxes=intervals(lambda b:b['rmsDbfs']>q90-1 and dynamic>3),transitionPoints=transitions),
        semantics=semantics,limitations=['Mood and semantic values are uncalibrated model estimates, not listener judgments.','Tempo is an onset estimate and may be unknown or half/double time.','Spectral values are measured on a 16 kHz mono derivative; loudness uses the original.','Quiet sections and climaxes are relative loudness regions, not formal musical analysis.','Tonal entropy is not a validated measure of harmonic complexity.','Lyrics, historical performance authenticity and composition dates cannot be established by this analyzer.','Semantic analysis samples at most eight ten-second windows; DSP covers the entire recording.'])

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('file');p.add_argument('--output',required=True);p.add_argument('--semantic-model',action='store_true')
    a=p.parse_args();r=analyze(a.file,AudioSemantics() if a.semantic_model else None)
    pathlib.Path(a.output).write_text(json.dumps(r,allow_nan=False,indent=2)+'\n')
    print(json.dumps(dict(policy=r['policy'],durationSeconds=r['durationSeconds'],semanticModel=r['semantics']['model'] if r['semantics'] else None)))
if __name__=='__main__':main()

"""Actual no-network synthetic Ogg through complete FFmpeg and DSP pipeline."""
import hashlib
import importlib.util
import pathlib
import subprocess
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
def load(name, key):
    spec = importlib.util.spec_from_file_location(key, HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

measure = load("measure-audio.py", "cove_full_decode_measure")
profile = load("profile-audio.py", "cove_full_signal_dsp")
with tempfile.TemporaryDirectory(prefix="cove-ffmpeg-qa-") as temp:
    file = pathlib.Path(temp) / "synthetic-original.ogg"
    subprocess.run([
        "ffmpeg","-nostdin","-hide_banner","-loglevel","error","-f","lavfi",
        "-i","sine=frequency=333:sample_rate=48000:duration=23",
        "-af","volume=0.6","-c:a","libvorbis","-q:a","4",str(file)],
        check=True,timeout=45)
    qa = measure.measure(file)
    assert qa["decodedFully"] is True
    assert qa["sourceSha1"] == hashlib.sha1(file.read_bytes()).hexdigest()
    assert qa["sha256"] == hashlib.sha256(file.read_bytes()).hexdigest()
    assert qa["bytes"] == file.stat().st_size
    assert 22 <= qa["durationSeconds"] <= 24
    assert qa["channels"] >= 1
    assert qa["sampleRate"] == 48000
    assert len(qa["tool"]) > 5
    output = profile.analyze(file)
    assert output["sha256"] == qa["sha256"]
    assert output["sourceSha1"] == qa["sourceSha1"]
    assert output["bytes"] == qa["bytes"]
    assert output["semantics"] is None
    assert output["decodedFully"] is True
    assert output["policy"] == "cove-music-v1"
    timeline = output["structure"]["timeline"]
    assert len(timeline) >= 2
    assert abs(timeline[0]["start"]) < 0.1
    assert abs(timeline[-1]["end"] - qa["durationSeconds"]) < 0.5
    print("ISOLATED_COMMONS_FULL_AUDIO_QA_PASS genuine Ogg decoding, exact hashes, bounded DSP, no inferred rights/quietness")

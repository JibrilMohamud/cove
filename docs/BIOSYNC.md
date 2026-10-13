# Biosync: verified text ↔ audio positions

Biosync identifies the exact EPUB and recording, then maps checked spoken words to exact EPUB CFIs. It never multiplies whole-book reading progress by total audio duration. Gutenberg text and audio editions may have different introductions, chapter grouping, translations, omissions, music, and abridgements.

## Current behavior

Version 2 maps use word precision. Switching to audio starts at the checked word containing the current EPUB CFI. Switching to text opens that word's CFI. A map activates only when its map, EPUB, and track SHA-256 values all match the current files. Missing passages preserve independent bookmarks and explain why handoff is unavailable.

The automated verifier accepts a map only when independent ASR words match exact EPUB words monotonically, every accepted word has probability at least `0.72`, at least 30 words match, and interior coverage is at least `0.80`. Gaps are explicit: an unmatched introduction, music, omitted prose, or a non-consecutive/long pause returns no synchronized position.

## Continuous pipeline

1. `bootstrap.py` reads the official bulk RDF data and daily feed, retaining only exact Project Gutenberg US public-domain audio records and all tracks.
2. The catalog endpoint creates durable discovery/track jobs. Workers claim 45-minute leases, heartbeat, retry with bounded backoff, and move repeated failures to review.
3. A worker downloads an original track resumably, verifies byte ranges and SHA-256, measures duration, pins the matching EPUB, and builds UTF-16-aware EPUB CFIs.
4. `faster-whisper` transcribes without book-text prompting. The aligner matches independent ASR output to normalized EPUB words; failed coverage remains `review` and is not published.
5. The Worker revalidates hashes, duration, monotonic time/CFI order, confidence, counts, and coverage before storing an immutable map. Position writes are also checked against the actual word at that audio time.

```sh
python -m scripts.audio_pipeline.runner --stdin --minutes 30 --max-jobs 100
```

The configuration is supplied on hidden standard input. Never put the Site access token or pipeline token in command arguments, logs, or the repository. Cached downloads and transcription results are disposable; D1 jobs and R2 content-addressed objects are authoritative.

Each cue has these fields (these are a schema description, not usable timing data):

| Field               | Meaning                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `trackId`           | Existing track identifier                                             |
| `start`, `end`      | Actual verified seconds in that track; start inclusive, end exclusive |
| `href`              | Local EPUB spine/chapter reference                                    |
| `cfi`, `endCfi`     | Start/end EPUB CFIs resolving in the exact hashed edition             |
| `text`, `wordIndex` | The exact normalized matched word and its EPUB sequence index         |
| `probability`       | Independent ASR confidence; must meet the map threshold               |

The EPUB hash, track hashes, and checked map travel in the combined download. Consumers enforce them. A new EPUB build or recording revision needs a new map. Account Biosync positions use optimistic version checks; a stale device is asked to reload instead of overwriting a newer position.

## Content and product work remaining

Automatic checks establish file identity and a conservative exact-text match; they are not a claim of human editorial review. Recordings or tracks that fail the threshold remain playable and enter review. A reviewer workspace, richer quality reporting, native-device integration, and the later recommendation engine are still separate work.

# Resumable hosted transcription

Long prepared recordings use SHA-256-pinned source audio and fixed 60-second
mono 16-kHz PCM WAV intervals. The trusted Python audio worker verifies the
entire source digest before decoding. The persistence Worker requires the
matching active alignment lease, bounds each upload to 1,920,044 bytes, checks
its PCM format and digest, then transcribes it with hosted Whisper. Actual
word timestamps and unknown confidence values are retained. No text prompt
or fabricated confidence is used.

Chunk ASR results live under
`biosync/transcripts/cloudflare-whisper-chunks-v2/<audio-sha256>/<index>.json`.
After a timeout, the next invocation skips those saved intervals. A deliberate
checkpoint refunds only the current claim attempt, and only after D1 verifies
that this exact lease saved the reported R2 chunk. Failed processing still
uses the existing bounded retry and review policy. The final transcript is
assembled only when every interval is present; cue timestamps receive the
interval's exact recording offset. Publication still requires the existing
independent ASR/exact EPUB verification contract and minimum coverage.
Zero-length or overlapping ASR tokens remain in the transcript and coverage
count. They cannot become published cues: the verifier requires positive cue
duration and monotonic ordering without adjusting the engine's timestamps.

Tests: `npm run test:biosync-chunks` and
`python3 -m unittest scripts.audio_pipeline.tests.test_hosted_chunks`.

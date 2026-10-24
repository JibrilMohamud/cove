# Blind quiet-reading assessment — release protocol

**No real human-labeled accuracy claim yet.** The acceptance statistics in `scripts/quiet-reading-benchmark.mjs` currently use synthetic fixtures only. Supplier titles, acoustic model scores, genre, and origin metadata are not ground truth.

Acquire at least **600 distinct immutable recording masters** with SHA-256 hashes, including at least 200 human-distracting and 200 human-quiet masters and 40 human-distracting masters per evaluated family (e.g. piano, orchestral, ambient, vocal). Obtain three or more independent listener votes for each, blind listeners to model output and metadata, and avoid training on the holdout recordings. Compare matched listening volume with silence/no-music control and a real reading comprehension task. Preserve blinded vote records and manifest hashes; do not re-distribute licensed audio. Resolve tied votes with additional blinded ratings rather than guessing.

Each `--dataset` JSON entry must include `masterSha256` (64 lowercase hex), `family`, `predictedTier`, and `ratings` of objects `{ "rater": "pseudonym", "label": "quiet" | "distracting" }`. Run:

```sh
node scripts/quiet-reading-benchmark.mjs --dataset=/path/to/independent_holdout.json
```

The initial **policy thresholds**, not measured Cove performance, are maximum one-sided 95% Wilson upper bound 5% for human-distracting tracks falsely marked suitable, and 15% per music family; minimum 55% recall of genuinely quiet tracks. Bad labels, missing families or insufficient samples fail closed.

This benchmark does not grant source licenses, public playback or territorial rights. High-volume acoustic inference must run off the customer D1, and canonical rights/revocation checks remain separate. Certify 100 RPS geographically, 32-concurrent bursts, mobile LCP and audio under background processing OFF/ON/OFF before commercial activation. Silence remains a valid reader preference.

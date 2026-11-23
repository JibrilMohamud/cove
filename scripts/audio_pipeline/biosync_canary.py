"""Compatibility entrypoint for protected BioSync owner QA, not a D1 writer.

The only implementation is biosync_owner_qa, which is physically pinned to
Cove's separate Cloudflare QA account and dedicated synthetic BioSync D1/R2.
Never restore a second Cloudflare REST SQL writer here or add a production
schedule until the replacement owner and genuine source transcripts are proven.
"""
from .biosync_owner_qa import *  # noqa: F401,F403 -- explicit backwards-compatible entrypoint

if __name__ == "__main__":
    main()

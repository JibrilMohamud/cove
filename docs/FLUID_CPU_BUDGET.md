# Cove Fluid CPU controls

The repository scheduled four-minute audio preparation/BioSync executions every
five minutes, plus discovery and alignment triggers. That is a substantial CPU
exposure independent of reader traffic. Vercel's detailed Active CPU query is
unavailable on the current Hobby account (402: Observability Plus required), so
this diagnosis is from the execution paths and schedules, not an attributed
billing measurement. Previously consumed CPU cannot be reclaimed by a deploy.

## New processing policy

New audio processing is **paused by default**. The existing catalog scheduler,
account maintenance, prepared audiobook playback, and completed BioSync mappings
continue. Queued work is retained; a skipped admission does not claim or fail a
job. This deliberately slows creation of new prepared audio/maps to protect the
exhausted allowance.

The persistence Worker owns the policy:

| Variable                          | Default  | Effect                                                                             |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `FORE_AUDIO_COMPUTE_MODE`         | `paused` | Set to `budgeted` to permit bounded new processing.                                |
| `FORE_AUDIO_MONTHLY_SECONDS`      | `3600`   | Worst-case five-minute CPU reservations per UTC calendar month; upper limit 7200.  |
| `FORE_AUDIO_MIN_INTERVAL_SECONDS` | `86400`  | Minimum time between admitted runs, across schedules and deployments; minimum 300. |

Vercel's independent `FORE_AUDIO_COMPUTE_MODE=paused` controller switch prevents
invoking the Python service. To resume, remove that pause in Vercel **and** set the
Worker to `budgeted`. Retain the default budget/cooldown while measuring actual
usage. These reservations are not Vercel's billing meter; calendar months may
differ from the account's billing period. The app and other projects also consume
the shared allowance.

Every direct or queue execution requests an atomic D1 admission before importing
processing code, downloading media, allocating model caches, or leasing work.
Each reserves the complete 300-second invocation regardless of failure, a lost
response, or actual runtime; reservations are not refunded. Default admission
allows at most 12 processing runs per calendar month. Queue concurrency and
delivery attempts are both one; D1 job checkpoints/backoff remain authoritative.
The Vercel processing thread count is one. External `runner.py` execution is still
available for a separately provisioned worker; this change does not provision or
move charges to another paid service.

## Reader and request changes

- Public sharing links now find the same library state as source and internal
  product IDs. Position saves use its actual version. Older account snapshots
  cannot roll the locally confirmed version backwards.
- A real 409 stops all queued/autosaved position writes. The status button reloads
  the reader before any subsequent save, preserving the remote position.
- Social reader queries no longer multiply by displayed chapter/percentage or
  send caller progress. They refresh after accepted saved progress, explicit
  changes, focus and a one-minute visible-page interval. Feed and sharing polls
  also use one minute (half their previous rate).
- Active session writes use one minute (one quarter of the previous periodic
  rate), with final visibility/cleanup saves and duplicate suppression. A browser
  crash can lose up to one minute of unsent session statistics; reading-position
  debounce remains 1.2 seconds.
- Vercel APIs with a configured persistence gateway avoid eagerly loading the
  approximately 2 MB server backend. Public invariant HTML shells are cacheable
  for five minutes at Vercel; account routes, bearer/query URLs, errors,
  authorization/cookies and private/no-store responses are excluded by the
  application. Hydrated account requests remain private.

## Rollout and verification

Apply migrations `0049_journey_recipient_access.sql` and
`0050_audio_compute_budget.sql`, deploy the persistence Worker with paused policy,
then deploy the frontend/Python service. An old Worker without the admission
endpoint cannot start new Python processing through the guarded controller.
Environment edits only reach a Vercel deployment when a new build is deployed.

Run `npm run test:compute-budget`, the reader/sharing/journey/backend integration
checks, Python runtime tests and the six-project browser matrix. Inspect D1's
`audio_compute_budgets` for reservations when processing is enabled. Compare
Vercel's Usage Active CPU after rollout with the preceding period; do not treat a
request-count reduction as a measured CPU/billing reduction.

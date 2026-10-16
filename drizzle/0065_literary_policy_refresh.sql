-- Restart the bounded sweep for the v2 evidence-abstention/bibliography policy.
-- Existing evidence/revisions remain intact; changed fingerprints supersede work.
UPDATE literary_profile_state SET cursor='',lease_token='',lease_until='' WHERE id=1;
-- In-flight v1 sections may contain distribution boilerplate. Their outputs must
-- not publish after the new extraction policy; the sweep creates new pinned jobs.
UPDATE literary_profile_jobs SET status='superseded',lease_until='' WHERE status IN ('queued','running');

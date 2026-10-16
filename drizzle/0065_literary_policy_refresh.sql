-- Restart the bounded sweep for the v2 evidence-abstention/bibliography policy.
-- Existing evidence/revisions remain intact; changed fingerprints supersede work.
UPDATE literary_profile_state SET cursor='',lease_token='',lease_until='' WHERE id=1;

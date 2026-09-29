-- Operational hardening for rightsholder disputes and Cove's versioned AI/content policy.

CREATE TABLE publishing_policy_versions (
  policy_key TEXT NOT NULL,
  version TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','retired')),
  summary TEXT NOT NULL DEFAULT '',
  rules_json TEXT NOT NULL DEFAULT '{}',
  effective_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(policy_key,version)
);
CREATE UNIQUE INDEX idx_publishing_policy_one_active ON publishing_policy_versions(policy_key) WHERE status='active';

INSERT INTO publishing_policy_versions(policy_key,version,title,status,summary,rules_json,effective_at,published_at,created_at) VALUES
('publisher_rights','fore-rights-v1','Cove Publisher Rights Declaration','active','Publishers must possess and truthfully declare the rights needed for every territory and format they distribute through Cove.','{"evidenceRequiredFor":["licensed","public_domain"],"falseDeclarationEnforcement":true,"rightsEvidencePrivate":true}','2026-09-24T00:00:00.000Z','2026-09-24T00:00:00.000Z','2026-09-24T00:00:00.000Z'),
('ai_content','fore-ai-content-v1','Cove AI & Automated Content Policy','active','Cove permits responsibly produced AI-assisted and AI-generated material when accurately disclosed, lawful, non-misleading, and not spammy or low-value derivative flooding.','{"publisherDisclosureRequired":true,"aiAssistedDisclosureRequired":true,"publicLabels":{"aiGeneratedText":true,"aiGeneratedCover":true,"aiGeneratedTranslation":true,"syntheticNarration":true,"aiAssisted":false},"prohibited":["undeclared_generated_content","spammy_mass_production","low_value_derivative_books","misleading_metadata","rights_violations","impersonation"],"humanEditorialReviewRequired":true}','2026-09-24T00:00:00.000Z','2026-09-24T00:00:00.000Z','2026-09-24T00:00:00.000Z'),
('repeat_infringer','fore-repeat-infringer-v1','Cove Repeat Infringer Policy','active','Confirmed infringement incidents accrue strike points and can restrict publishing access or require account termination review.','{"warningPoints":3,"restrictionPoints":6,"terminationReviewPoints":9,"manualTerminationReview":true,"appealAndOverturnSupported":true}','2026-09-24T00:00:00.000Z','2026-09-24T00:00:00.000Z','2026-09-24T00:00:00.000Z');

ALTER TABLE copyright_notices ADD COLUMN reported_url TEXT NOT NULL DEFAULT '';

CREATE TABLE copyright_court_actions (
  id TEXT PRIMARY KEY NOT NULL,
  dispute_id TEXT NOT NULL REFERENCES rights_disputes(id) ON DELETE RESTRICT,
  filed_by TEXT NOT NULL DEFAULT 'claimant' CHECK(filed_by IN ('claimant','publisher','other')),
  court TEXT NOT NULL,
  case_number TEXT NOT NULL,
  filing_date TEXT NOT NULL,
  evidence_reference TEXT NOT NULL DEFAULT '',
  recorded_by_user_id TEXT NOT NULL REFERENCES staff_principals(user_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(dispute_id,court,case_number)
);
CREATE INDEX idx_copyright_court_actions_dispute ON copyright_court_actions(dispute_id,created_at DESC);

CREATE TABLE publishing_publication_disclosures (
  publication_version_id TEXT PRIMARY KEY NOT NULL REFERENCES publishing_publication_versions(id) ON DELETE RESTRICT,
  ai_disclosure_id TEXT NOT NULL REFERENCES publishing_ai_disclosures(id) ON DELETE RESTRICT,
  policy_version TEXT NOT NULL,
  text_origin TEXT NOT NULL,
  cover_origin TEXT NOT NULL,
  narration_origin TEXT NOT NULL,
  translation_origin TEXT NOT NULL,
  synthetic_voice_label TEXT NOT NULL DEFAULT '',
  public_badges_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_publication_disclosures_policy ON publishing_publication_disclosures(policy_version,created_at DESC);

CREATE TRIGGER trg_policy_version_core_immutable BEFORE UPDATE OF policy_key,version,title,summary,rules_json,effective_at,published_at,created_at ON publishing_policy_versions BEGIN SELECT RAISE(ABORT,'published policy text and rules are immutable; publish a new version'); END;
CREATE TRIGGER trg_policy_version_no_delete BEFORE DELETE ON publishing_policy_versions BEGIN SELECT RAISE(ABORT,'published policy versions cannot be deleted'); END;
CREATE TRIGGER trg_copyright_court_action_no_update BEFORE UPDATE ON copyright_court_actions BEGIN SELECT RAISE(ABORT,'court action evidence is immutable'); END;
CREATE TRIGGER trg_copyright_court_action_no_delete BEFORE DELETE ON copyright_court_actions BEGIN SELECT RAISE(ABORT,'court action evidence cannot be deleted'); END;
CREATE TRIGGER trg_publication_disclosure_no_update BEFORE UPDATE ON publishing_publication_disclosures BEGIN SELECT RAISE(ABORT,'publication disclosures are immutable per publication version'); END;
CREATE TRIGGER trg_publication_disclosure_no_delete BEFORE DELETE ON publishing_publication_disclosures BEGIN SELECT RAISE(ABORT,'publication disclosures cannot be deleted'); END;

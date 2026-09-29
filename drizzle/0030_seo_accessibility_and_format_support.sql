PRAGMA foreign_keys=ON;

-- Accessibility and rendering metadata are edition-scoped and derived from an immutable source asset inspection.
CREATE TABLE IF NOT EXISTS edition_accessibility_profiles (
  edition_id TEXT PRIMARY KEY NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  source_asset_version_id TEXT REFERENCES asset_versions(id) ON DELETE SET NULL,
  visual_adjustments TEXT NOT NULL DEFAULT 'unknown' CHECK(visual_adjustments IN ('supported','limited','not_supported','unknown')),
  nonvisual_reading TEXT NOT NULL DEFAULT 'unknown' CHECK(nonvisual_reading IN ('supported','partial','not_supported','unknown')),
  primary_language_declared INTEGER NOT NULL DEFAULT 0 CHECK(primary_language_declared IN (0,1)),
  reading_order_verified INTEGER NOT NULL DEFAULT 0 CHECK(reading_order_verified IN (0,1)),
  table_semantics_complete INTEGER NOT NULL DEFAULT 0 CHECK(table_semantics_complete IN (0,1)),
  mathml_present INTEGER NOT NULL DEFAULT 0 CHECK(mathml_present IN (0,1)),
  mathml_accessible INTEGER NOT NULL DEFAULT 0 CHECK(mathml_accessible IN (0,1)),
  page_navigation INTEGER NOT NULL DEFAULT 0 CHECK(page_navigation IN (0,1)),
  accessibility_navigation INTEGER NOT NULL DEFAULT 0 CHECK(accessibility_navigation IN (0,1)),
  access_modes_json TEXT NOT NULL DEFAULT '[]',
  access_mode_sufficient_json TEXT NOT NULL DEFAULT '[]',
  features_json TEXT NOT NULL DEFAULT '[]',
  hazards_json TEXT NOT NULL DEFAULT '[]',
  conforms_to_json TEXT NOT NULL DEFAULT '[]',
  certification_json TEXT NOT NULL DEFAULT '{}',
  accessibility_summary TEXT NOT NULL DEFAULT '',
  validation_policy_version TEXT NOT NULL DEFAULT 'fore-epub-accessibility-v1',
  validation_status TEXT NOT NULL DEFAULT 'unknown' CHECK(validation_status IN ('passed','warning','failed','unknown')),
  validation_report_json TEXT NOT NULL DEFAULT '{}',
  publisher_declaration_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edition_format_profiles (
  edition_id TEXT PRIMARY KEY NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  source_asset_version_id TEXT REFERENCES asset_versions(id) ON DELETE SET NULL,
  epub_version TEXT NOT NULL DEFAULT '',
  package_version TEXT NOT NULL DEFAULT '',
  navigation_type TEXT NOT NULL DEFAULT 'unknown' CHECK(navigation_type IN ('epub3_nav','ncx','both','unknown')),
  rendition_layout TEXT NOT NULL DEFAULT 'reflowable' CHECK(rendition_layout IN ('reflowable','pre-paginated','unknown')),
  page_progression_direction TEXT NOT NULL DEFAULT 'default' CHECK(page_progression_direction IN ('ltr','rtl','default')),
  writing_mode TEXT NOT NULL DEFAULT 'horizontal-tb',
  rtl INTEGER NOT NULL DEFAULT 0 CHECK(rtl IN (0,1)),
  vertical_writing INTEGER NOT NULL DEFAULT 0 CHECK(vertical_writing IN (0,1)),
  complex_css INTEGER NOT NULL DEFAULT 0 CHECK(complex_css IN (0,1)),
  embedded_fonts INTEGER NOT NULL DEFAULT 0 CHECK(embedded_fonts IN (0,1)),
  svg INTEGER NOT NULL DEFAULT 0 CHECK(svg IN (0,1)),
  mathml INTEGER NOT NULL DEFAULT 0 CHECK(mathml IN (0,1)),
  complex_tables INTEGER NOT NULL DEFAULT 0 CHECK(complex_tables IN (0,1)),
  footnotes INTEGER NOT NULL DEFAULT 0 CHECK(footnotes IN (0,1)),
  endnotes INTEGER NOT NULL DEFAULT 0 CHECK(endnotes IN (0,1)),
  dictionary_content INTEGER NOT NULL DEFAULT 0 CHECK(dictionary_content IN (0,1)),
  media_overlays INTEGER NOT NULL DEFAULT 0 CHECK(media_overlays IN (0,1)),
  oversized_images INTEGER NOT NULL DEFAULT 0 CHECK(oversized_images IN (0,1)),
  accessibility_navigation INTEGER NOT NULL DEFAULT 0 CHECK(accessibility_navigation IN (0,1)),
  compatibility_class TEXT NOT NULL DEFAULT 'unknown' CHECK(compatibility_class IN ('reflowable_standard','reflowable_complex','fixed_layout','comic_manga','picture_book','dictionary','unknown')),
  reader_support TEXT NOT NULL DEFAULT 'supported_with_limits' CHECK(reader_support IN ('full','supported_with_limits','preview_only','unsupported')),
  features_json TEXT NOT NULL DEFAULT '{}',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publishing_epub_inspections (
  asset_version_id TEXT PRIMARY KEY NOT NULL REFERENCES publishing_asset_versions(id) ON DELETE CASCADE,
  inspection_version TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  accessibility_json TEXT NOT NULL,
  format_profile_json TEXT NOT NULL,
  issue_summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS trg_publishing_epub_inspections_immutable_update BEFORE UPDATE ON publishing_epub_inspections BEGIN SELECT RAISE(ABORT,'publishing epub inspections are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_publishing_epub_inspections_immutable_delete BEFORE DELETE ON publishing_epub_inspections BEGIN SELECT RAISE(ABORT,'publishing epub inspections are immutable'); END;

CREATE TABLE IF NOT EXISTS publishing_accessibility_declarations (
  edition_id TEXT NOT NULL REFERENCES publishing_edition_drafts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  policy_version TEXT NOT NULL DEFAULT 'fore-epub-accessibility-v1',
  declaration_json TEXT NOT NULL,
  attested_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(edition_id,revision)
);
CREATE TRIGGER IF NOT EXISTS trg_publishing_accessibility_declarations_immutable_update BEFORE UPDATE ON publishing_accessibility_declarations BEGIN SELECT RAISE(ABORT,'publishing accessibility declarations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_publishing_accessibility_declarations_immutable_delete BEFORE DELETE ON publishing_accessibility_declarations BEGIN SELECT RAISE(ABORT,'publishing accessibility declarations are immutable'); END;

CREATE TABLE IF NOT EXISTS accessibility_policy_versions (
  id TEXT PRIMARY KEY NOT NULL,
  standard TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS trg_accessibility_policy_versions_immutable_update BEFORE UPDATE ON accessibility_policy_versions BEGIN SELECT RAISE(ABORT,'accessibility policy versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_accessibility_policy_versions_immutable_delete BEFORE DELETE ON accessibility_policy_versions BEGIN SELECT RAISE(ABORT,'accessibility policy versions are immutable'); END;
INSERT OR IGNORE INTO accessibility_policy_versions(id,standard,policy_json,status,created_at) VALUES(
 'fore-epub-accessibility-v1','EPUB Accessibility 1.1 / WCAG 2.2 AA',
 '{"requiredMetadata":["accessMode","accessibilityFeature","accessibilityHazard"],"recommendedMetadata":["accessibilitySummary","accessModeSufficient"],"checks":["primaryLanguage","headingStructure","meaningfulImageAlternatives","readingOrder","tableHeaders","mathML","navigation"],"disclosure":{"visualAdjustments":true,"nonvisualReading":true,"hazards":true,"knownLimitations":true}}',
 'active',datetime('now'));

CREATE TABLE IF NOT EXISTS accessibility_audit_runs (
  id TEXT PRIMARY KEY NOT NULL,
  surface TEXT NOT NULL CHECK(surface IN ('store','checkout','reader','publishing','staff','auth','sitewide')),
  standard TEXT NOT NULL DEFAULT 'WCAG 2.2 AA',
  scanner TEXT NOT NULL,
  scanner_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('passed','warning','failed')),
  critical_count INTEGER NOT NULL DEFAULT 0,
  serious_count INTEGER NOT NULL DEFAULT 0,
  moderate_count INTEGER NOT NULL DEFAULT 0,
  minor_count INTEGER NOT NULL DEFAULT 0,
  report_object_key TEXT,
  report_sha256 TEXT,
  commit_ref TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accessibility_audits_surface_created ON accessibility_audit_runs(surface,created_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_accessibility_audit_runs_immutable_update BEFORE UPDATE ON accessibility_audit_runs BEGIN SELECT RAISE(ABORT,'accessibility audit evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_accessibility_audit_runs_immutable_delete BEFORE DELETE ON accessibility_audit_runs BEGIN SELECT RAISE(ABORT,'accessibility audit evidence is immutable'); END;

INSERT OR IGNORE INTO staff_role_permissions(role_id,permission) VALUES
 ('role_publishing_reviewer','accessibility.review'),
 ('role_senior_moderator','accessibility.audit.read'),
 ('role_moderation_admin','accessibility.review'),
 ('role_moderation_admin','accessibility.audit.read'),
 ('role_moderation_admin','accessibility.audit.manage');

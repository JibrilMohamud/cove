-- Inverted literary index: bounded online retrieval, no per-request inference.
CREATE TABLE recommendation_book_features (
 product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 dimension TEXT NOT NULL, feature TEXT NOT NULL,
 confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1), revision INTEGER NOT NULL,
 PRIMARY KEY(product_id,dimension,feature)
);
CREATE INDEX idx_rec_literary_lookup ON recommendation_book_features(dimension,feature,confidence DESC,product_id);
CREATE TABLE recommendation_taste_controls (
 user_id TEXT PRIMARY KEY, preferences_json TEXT NOT NULL CHECK(json_valid(preferences_json)),
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
CREATE TRIGGER rec_literary_insert AFTER INSERT ON literary_profiles BEGIN
DELETE FROM recommendation_book_features WHERE product_id=NEW.product_id;
INSERT OR REPLACE INTO recommendation_book_features(product_id,dimension,feature,confidence,revision)
SELECT NEW.product_id, 'themes', lower(trim(CAST(j.value AS TEXT))), CAST(json_extract(NEW.profile_json, '$.themes.confidence') AS REAL), NEW.revision FROM json_each(NEW.profile_json, '$.themes.value') j WHERE NEW.status<>'failed' AND json_extract(NEW.profile_json, '$.themes.confidence') >= 0.25 AND length(trim(CAST(j.value AS TEXT))) BETWEEN 1 AND 80 AND json_array_length(json_extract(NEW.profile_json, '$.themes.evidence'))>0
UNION ALL
SELECT NEW.product_id, 'moods', lower(trim(CAST(j.value AS TEXT))), CAST(json_extract(NEW.profile_json, '$.moods.confidence') AS REAL), NEW.revision FROM json_each(NEW.profile_json, '$.moods.value') j WHERE NEW.status<>'failed' AND json_extract(NEW.profile_json, '$.moods.confidence') >= 0.25 AND length(trim(CAST(j.value AS TEXT))) BETWEEN 1 AND 80 AND json_array_length(json_extract(NEW.profile_json, '$.moods.evidence'))>0
UNION ALL
SELECT NEW.product_id, 'literaryStyle', lower(trim(CAST(j.value AS TEXT))), CAST(json_extract(NEW.profile_json, '$.literaryStyle.confidence') AS REAL), NEW.revision FROM json_each(NEW.profile_json, '$.literaryStyle.value') j WHERE NEW.status<>'failed' AND json_extract(NEW.profile_json, '$.literaryStyle.confidence') >= 0.25 AND length(trim(CAST(j.value AS TEXT))) BETWEEN 1 AND 80 AND json_array_length(json_extract(NEW.profile_json, '$.literaryStyle.evidence'))>0
UNION ALL
SELECT NEW.product_id, 'geography', lower(trim(CAST(j.value AS TEXT))), CAST(json_extract(NEW.profile_json, '$.geography.confidence') AS REAL), NEW.revision FROM json_each(NEW.profile_json, '$.geography.value') j WHERE NEW.status<>'failed' AND json_extract(NEW.profile_json, '$.geography.confidence') >= 0.25 AND length(trim(CAST(j.value AS TEXT))) BETWEEN 1 AND 80 AND json_array_length(json_extract(NEW.profile_json, '$.geography.evidence'))>0
UNION ALL
SELECT NEW.product_id, 'sensoryAtmosphere', lower(trim(CAST(j.value AS TEXT))), CAST(json_extract(NEW.profile_json, '$.sensoryAtmosphere.confidence') AS REAL), NEW.revision FROM json_each(NEW.profile_json, '$.sensoryAtmosphere.value') j WHERE NEW.status<>'failed' AND json_extract(NEW.profile_json, '$.sensoryAtmosphere.confidence') >= 0.25 AND length(trim(CAST(j.value AS TEXT))) BETWEEN 1 AND 80 AND json_array_length(json_extract(NEW.profile_json, '$.sensoryAtmosphere.evidence'))>0;
END;
CREATE TRIGGER rec_literary_update AFTER UPDATE ON literary_profiles BEGIN
DELETE FROM recommendation_book_features WHERE product_id=NEW.product_id;
INSERT OR REPLACE INTO recommendation_book_features(product_id,dimension,feature,confidence,revision)
SELECT NEW.product_id, 'themes', lower(trim(CAST(j.value AS TEXT))), CAST(json_extract(NEW.profile_json, '$.themes.confidence') AS REAL), NEW.revision FROM json_each(NEW.profile_json, '$.themes.value') j WHERE NEW.status<>'failed' AND json_extract(NEW.profile_json, '$.themes.confidence') >= 0.25 AND length(trim(CAST(j.value AS TEXT))) BETWEEN 1 AND 80 AND json_array_length(json_extract(NEW.profile_json, '$.themes.evidence'))>0
UNION ALL
SELECT NEW.product_id, 'moods', lower(trim(CAST(j.value AS TEXT))), CAST(json_extract(NEW.profile_json, '$.moods.confidence') AS REAL), NEW.revision FROM json_each(NEW.profile_json, '$.moods.value') j WHERE NEW.status<>'failed' AND json_extract(NEW.profile_json, '$.moods.confidence') >= 0.25 AND length(trim(CAST(j.value AS TEXT))) BETWEEN 1 AND 80 AND json_array_length(json_extract(NEW.profile_json, '$.moods.evidence'))>0
UNION ALL
SELECT NEW.product_id, 'literaryStyle', lower(trim(CAST(j.value AS TEXT))), CAST(json_extract(NEW.profile_json, '$.literaryStyle.confidence') AS REAL), NEW.revision FROM json_each(NEW.profile_json, '$.literaryStyle.value') j WHERE NEW.status<>'failed' AND json_extract(NEW.profile_json, '$.literaryStyle.confidence') >= 0.25 AND length(trim(CAST(j.value AS TEXT))) BETWEEN 1 AND 80 AND json_array_length(json_extract(NEW.profile_json, '$.literaryStyle.evidence'))>0
UNION ALL
SELECT NEW.product_id, 'geography', lower(trim(CAST(j.value AS TEXT))), CAST(json_extract(NEW.profile_json, '$.geography.confidence') AS REAL), NEW.revision FROM json_each(NEW.profile_json, '$.geography.value') j WHERE NEW.status<>'failed' AND json_extract(NEW.profile_json, '$.geography.confidence') >= 0.25 AND length(trim(CAST(j.value AS TEXT))) BETWEEN 1 AND 80 AND json_array_length(json_extract(NEW.profile_json, '$.geography.evidence'))>0
UNION ALL
SELECT NEW.product_id, 'sensoryAtmosphere', lower(trim(CAST(j.value AS TEXT))), CAST(json_extract(NEW.profile_json, '$.sensoryAtmosphere.confidence') AS REAL), NEW.revision FROM json_each(NEW.profile_json, '$.sensoryAtmosphere.value') j WHERE NEW.status<>'failed' AND json_extract(NEW.profile_json, '$.sensoryAtmosphere.confidence') >= 0.25 AND length(trim(CAST(j.value AS TEXT))) BETWEEN 1 AND 80 AND json_array_length(json_extract(NEW.profile_json, '$.sensoryAtmosphere.evidence'))>0;
END;
INSERT OR REPLACE INTO recommendation_book_features(product_id,dimension,feature,confidence,revision)
SELECT p.product_id, 'themes', lower(trim(CAST(j.value AS TEXT))), CAST(json_extract(p.profile_json, '$.themes.confidence') AS REAL), p.revision FROM literary_profiles p, json_each(p.profile_json, '$.themes.value') j WHERE p.status<>'failed' AND json_extract(p.profile_json, '$.themes.confidence') >= 0.25 AND length(trim(CAST(j.value AS TEXT))) BETWEEN 1 AND 80 AND json_array_length(json_extract(p.profile_json, '$.themes.evidence'))>0
UNION ALL
SELECT p.product_id, 'moods', lower(trim(CAST(j.value AS TEXT))), CAST(json_extract(p.profile_json, '$.moods.confidence') AS REAL), p.revision FROM literary_profiles p, json_each(p.profile_json, '$.moods.value') j WHERE p.status<>'failed' AND json_extract(p.profile_json, '$.moods.confidence') >= 0.25 AND length(trim(CAST(j.value AS TEXT))) BETWEEN 1 AND 80 AND json_array_length(json_extract(p.profile_json, '$.moods.evidence'))>0
UNION ALL
SELECT p.product_id, 'literaryStyle', lower(trim(CAST(j.value AS TEXT))), CAST(json_extract(p.profile_json, '$.literaryStyle.confidence') AS REAL), p.revision FROM literary_profiles p, json_each(p.profile_json, '$.literaryStyle.value') j WHERE p.status<>'failed' AND json_extract(p.profile_json, '$.literaryStyle.confidence') >= 0.25 AND length(trim(CAST(j.value AS TEXT))) BETWEEN 1 AND 80 AND json_array_length(json_extract(p.profile_json, '$.literaryStyle.evidence'))>0
UNION ALL
SELECT p.product_id, 'geography', lower(trim(CAST(j.value AS TEXT))), CAST(json_extract(p.profile_json, '$.geography.confidence') AS REAL), p.revision FROM literary_profiles p, json_each(p.profile_json, '$.geography.value') j WHERE p.status<>'failed' AND json_extract(p.profile_json, '$.geography.confidence') >= 0.25 AND length(trim(CAST(j.value AS TEXT))) BETWEEN 1 AND 80 AND json_array_length(json_extract(p.profile_json, '$.geography.evidence'))>0
UNION ALL
SELECT p.product_id, 'sensoryAtmosphere', lower(trim(CAST(j.value AS TEXT))), CAST(json_extract(p.profile_json, '$.sensoryAtmosphere.confidence') AS REAL), p.revision FROM literary_profiles p, json_each(p.profile_json, '$.sensoryAtmosphere.value') j WHERE p.status<>'failed' AND json_extract(p.profile_json, '$.sensoryAtmosphere.confidence') >= 0.25 AND length(trim(CAST(j.value AS TEXT))) BETWEEN 1 AND 80 AND json_array_length(json_extract(p.profile_json, '$.sensoryAtmosphere.evidence'))>0;
ALTER TABLE recommendation_impressions ADD COLUMN feature_snapshot_json TEXT NOT NULL DEFAULT '[]';
CREATE INDEX idx_rec_events_attribution ON recommendation_events(recommendation_request_id,user_id,product_id,event_type,occurred_at);
CREATE TRIGGER rec_literary_delete AFTER DELETE ON literary_profiles BEGIN
 DELETE FROM recommendation_book_features WHERE product_id=OLD.product_id;
END;
CREATE TABLE recommendation_learning_boundaries (
 user_id TEXT PRIMARY KEY, reset_at TEXT NOT NULL
);

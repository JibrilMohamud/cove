-- Compact materialized retrieval index: original reports remain private in R2.
CREATE TABLE matching_audio_index (
 recording_id TEXT PRIMARY KEY REFERENCES music_profiles(recording_id) ON DELETE CASCADE,
 fingerprint TEXT NOT NULL, energy REAL NOT NULL, duration_seconds REAL NOT NULL,
 compact_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_matching_energy ON matching_audio_index(energy,recording_id);
CREATE TABLE matching_audio_tags (
 recording_id TEXT NOT NULL REFERENCES matching_audio_index(recording_id) ON DELETE CASCADE,
 kind TEXT NOT NULL,tag TEXT NOT NULL,PRIMARY KEY(recording_id,kind,tag)
);
CREATE INDEX idx_matching_tags ON matching_audio_tags(kind,tag,recording_id);
INSERT INTO matching_audio_index(recording_id,fingerprint,energy,duration_seconds,compact_json,updated_at) SELECT recording_id,fingerprint,json_extract(profile_json,'$.audioAnalysis.signal.energy'),json_extract(profile_json,'$.audioAnalysis.durationSeconds'),json_object('durationSeconds',json_extract(profile_json,'$.audioAnalysis.durationSeconds'),'signal',json_extract(profile_json,'$.audioAnalysis.signal'),'loudness',json_extract(profile_json,'$.audioAnalysis.loudness'),'semantics',json_extract(profile_json,'$.audioAnalysis.semantics'),'entry',json_extract(profile_json,'$.audioAnalysis.structure.timeline[0]'),'exit',json_extract(profile_json,'$.audioAnalysis.structure.timeline[#-1]'),'trajectory',json((SELECT json_group_array(json(value)) FROM (SELECT value FROM json_each(profile_json,'$.audioAnalysis.structure.timeline') WHERE CAST(key AS INTEGER) IN (0,CAST((json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1)/7 AS INTEGER),CAST(2*(json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1)/7 AS INTEGER),CAST(3*(json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1)/7 AS INTEGER),CAST(4*(json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1)/7 AS INTEGER),CAST(5*(json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1)/7 AS INTEGER),CAST(6*(json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1)/7 AS INTEGER),json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1) ORDER BY CAST(key AS INTEGER)))),'semanticFraction',COALESCE(json_extract(profile_json,'$.analysisCoverage.semanticFraction'),0),'sourceSha1',json_extract(profile_json,'$.audioAnalysis.sourceSha1'),'sha256',json_extract(profile_json,'$.audioAnalysis.sha256')),updated_at FROM music_profiles WHERE status='analyzed' AND json_type(profile_json,'$.audioAnalysis')='object';
INSERT OR IGNORE INTO matching_audio_tags(recording_id,kind,tag) SELECT p.recording_id,'mood',lower(json_extract(t.value,'$.label')) FROM music_profiles p,json_each(p.profile_json,'$.audioAnalysis.semantics.moods') t WHERE p.status='analyzed' AND json_type(p.profile_json,'$.audioAnalysis')='object';
CREATE TRIGGER matching_audio_insert AFTER INSERT ON music_profiles
BEGIN
 DELETE FROM matching_audio_tags WHERE recording_id=NEW.recording_id;
 DELETE FROM matching_audio_index WHERE recording_id=NEW.recording_id;
 INSERT INTO matching_audio_index(recording_id,fingerprint,energy,duration_seconds,compact_json,updated_at) SELECT recording_id,fingerprint,json_extract(profile_json,'$.audioAnalysis.signal.energy'),json_extract(profile_json,'$.audioAnalysis.durationSeconds'),json_object('durationSeconds',json_extract(profile_json,'$.audioAnalysis.durationSeconds'),'signal',json_extract(profile_json,'$.audioAnalysis.signal'),'loudness',json_extract(profile_json,'$.audioAnalysis.loudness'),'semantics',json_extract(profile_json,'$.audioAnalysis.semantics'),'entry',json_extract(profile_json,'$.audioAnalysis.structure.timeline[0]'),'exit',json_extract(profile_json,'$.audioAnalysis.structure.timeline[#-1]'),'trajectory',json((SELECT json_group_array(json(value)) FROM (SELECT value FROM json_each(profile_json,'$.audioAnalysis.structure.timeline') WHERE CAST(key AS INTEGER) IN (0,CAST((json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1)/7 AS INTEGER),CAST(2*(json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1)/7 AS INTEGER),CAST(3*(json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1)/7 AS INTEGER),CAST(4*(json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1)/7 AS INTEGER),CAST(5*(json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1)/7 AS INTEGER),CAST(6*(json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1)/7 AS INTEGER),json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1) ORDER BY CAST(key AS INTEGER)))),'semanticFraction',COALESCE(json_extract(profile_json,'$.analysisCoverage.semanticFraction'),0),'sourceSha1',json_extract(profile_json,'$.audioAnalysis.sourceSha1'),'sha256',json_extract(profile_json,'$.audioAnalysis.sha256')),updated_at FROM music_profiles WHERE status='analyzed' AND json_type(profile_json,'$.audioAnalysis')='object' AND recording_id=NEW.recording_id;
 INSERT OR IGNORE INTO matching_audio_tags(recording_id,kind,tag) SELECT p.recording_id,'mood',lower(json_extract(t.value,'$.label')) FROM music_profiles p,json_each(p.profile_json,'$.audioAnalysis.semantics.moods') t WHERE p.status='analyzed' AND json_type(p.profile_json,'$.audioAnalysis')='object' AND p.recording_id=NEW.recording_id;
END;
CREATE TRIGGER matching_audio_update AFTER UPDATE OF profile_json,status,fingerprint ON music_profiles
BEGIN
 DELETE FROM matching_audio_tags WHERE recording_id=NEW.recording_id;
 DELETE FROM matching_audio_index WHERE recording_id=NEW.recording_id;
 INSERT INTO matching_audio_index(recording_id,fingerprint,energy,duration_seconds,compact_json,updated_at) SELECT recording_id,fingerprint,json_extract(profile_json,'$.audioAnalysis.signal.energy'),json_extract(profile_json,'$.audioAnalysis.durationSeconds'),json_object('durationSeconds',json_extract(profile_json,'$.audioAnalysis.durationSeconds'),'signal',json_extract(profile_json,'$.audioAnalysis.signal'),'loudness',json_extract(profile_json,'$.audioAnalysis.loudness'),'semantics',json_extract(profile_json,'$.audioAnalysis.semantics'),'entry',json_extract(profile_json,'$.audioAnalysis.structure.timeline[0]'),'exit',json_extract(profile_json,'$.audioAnalysis.structure.timeline[#-1]'),'trajectory',json((SELECT json_group_array(json(value)) FROM (SELECT value FROM json_each(profile_json,'$.audioAnalysis.structure.timeline') WHERE CAST(key AS INTEGER) IN (0,CAST((json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1)/7 AS INTEGER),CAST(2*(json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1)/7 AS INTEGER),CAST(3*(json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1)/7 AS INTEGER),CAST(4*(json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1)/7 AS INTEGER),CAST(5*(json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1)/7 AS INTEGER),CAST(6*(json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1)/7 AS INTEGER),json_array_length(profile_json,'$.audioAnalysis.structure.timeline')-1) ORDER BY CAST(key AS INTEGER)))),'semanticFraction',COALESCE(json_extract(profile_json,'$.analysisCoverage.semanticFraction'),0),'sourceSha1',json_extract(profile_json,'$.audioAnalysis.sourceSha1'),'sha256',json_extract(profile_json,'$.audioAnalysis.sha256')),updated_at FROM music_profiles WHERE status='analyzed' AND json_type(profile_json,'$.audioAnalysis')='object' AND recording_id=NEW.recording_id;
 INSERT OR IGNORE INTO matching_audio_tags(recording_id,kind,tag) SELECT p.recording_id,'mood',lower(json_extract(t.value,'$.label')) FROM music_profiles p,json_each(p.profile_json,'$.audioAnalysis.semantics.moods') t WHERE p.status='analyzed' AND json_type(p.profile_json,'$.audioAnalysis')='object' AND p.recording_id=NEW.recording_id;
END;
CREATE TABLE matching_preferences (
 user_id TEXT PRIMARY KEY REFERENCES profiles(user_id) ON DELETE CASCADE,
 preferences_json TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE TABLE matching_feedback (
 user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
 product_id TEXT NOT NULL,book_fingerprint TEXT NOT NULL,spine TEXT NOT NULL,
 mode TEXT NOT NULL,recording_id TEXT NOT NULL,music_fingerprint TEXT NOT NULL,
 reason TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(user_id,product_id,book_fingerprint,spine,mode,recording_id)
);
CREATE INDEX idx_matching_feedback_context ON matching_feedback(user_id,product_id,book_fingerprint,spine,mode);
CREATE TABLE matching_evaluations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,policy TEXT NOT NULL,actor TEXT NOT NULL,
 judgment_key TEXT UNIQUE,request_sha256 TEXT NOT NULL DEFAULT '',
 product_id TEXT NOT NULL,book_fingerprint TEXT NOT NULL,spine TEXT NOT NULL,mode TEXT NOT NULL,
 book_family TEXT NOT NULL,a_json TEXT NOT NULL,b_json TEXT NOT NULL,
 preferred TEXT NOT NULL CHECK(preferred IN ('a','b','tie')),created_at TEXT NOT NULL
);
CREATE TABLE matching_rankers (
 id TEXT PRIMARY KEY,artifact_json TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 0,
 approved_by TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_matching_active_ranker ON matching_rankers(active) WHERE active=1;
CREATE TRIGGER matching_ranker_immutable BEFORE UPDATE OF artifact_json ON matching_rankers
BEGIN SELECT RAISE(ABORT,'Ranker artifacts are immutable'); END;
CREATE TRIGGER matching_evaluation_immutable BEFORE UPDATE ON matching_evaluations
BEGIN SELECT RAISE(ABORT,'Editorial judgments are immutable'); END;

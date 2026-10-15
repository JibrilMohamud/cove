-- Localize social-reader onboarding and activity controls in the supported storefront locales.
-- Carry forward the prior active translations without overwriting publisher-owned text.
INSERT INTO ui_translation_bundles(id,locale,version,status,source,message_count,translated_count,coverage_bps,checksum_sha256,created_at,activated_at)
SELECT 'uib_en_us_v3','en-US',3,'draft','fore',0,0,0,'',datetime('now'),NULL
WHERE NOT EXISTS (SELECT 1 FROM ui_translation_bundles WHERE id='uib_en_us_v3');
INSERT OR IGNORE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at)
SELECT 'uib_en_us_v3',message_key,message_value,datetime('now') FROM ui_translation_messages WHERE bundle_id='uib_en_us_v2';
INSERT OR REPLACE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at) VALUES
 ('uib_en_us_v3','reader.social.guestTitle','Read alongside people you choose.',datetime('now')),
 ('uib_en_us_v3','reader.social.guestDescription','Sign in to enable spoiler-aware shared highlights and margin conversations.',datetime('now')),
 ('uib_en_us_v3','reader.social.signIn','Sign in',datetime('now')),
 ('uib_en_us_v3','reader.social.heading','Social Reading',datetime('now')),
 ('uib_en_us_v3','reader.social.description','Off by default. The book stays clean until you ask for this layer.',datetime('now')),
 ('uib_en_us_v3','reader.social.enable','Enable Social Reading',datetime('now')),
 ('uib_en_us_v3','reader.social.audience','Whose activity',datetime('now')),
 ('uib_en_us_v3','reader.social.discussions','Discussions',datetime('now')),
 ('uib_en_us_v3','reader.social.sharedHighlights','Shared highlights',datetime('now')),
 ('uib_en_us_v3','reader.social.reactions','Reactions',datetime('now'));
UPDATE ui_translation_bundles SET status='retired' WHERE id='uib_en_us_v2';
UPDATE ui_translation_bundles SET status='active',message_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_en_us_v3'),translated_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_en_us_v3'),coverage_bps=10000,activated_at=datetime('now') WHERE id='uib_en_us_v3';

INSERT INTO ui_translation_bundles(id,locale,version,status,source,message_count,translated_count,coverage_bps,checksum_sha256,created_at,activated_at)
SELECT 'uib_es_es_v3','es-ES',3,'draft','fore',0,0,0,'',datetime('now'),NULL
WHERE NOT EXISTS (SELECT 1 FROM ui_translation_bundles WHERE id='uib_es_es_v3');
INSERT OR IGNORE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at)
SELECT 'uib_es_es_v3',message_key,message_value,datetime('now') FROM ui_translation_messages WHERE bundle_id='uib_es_es_v2';
INSERT OR REPLACE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at) VALUES
 ('uib_es_es_v3','reader.social.guestTitle','Lee junto a las personas que elijas.',datetime('now')),
 ('uib_es_es_v3','reader.social.guestDescription','Inicia sesión para activar los fragmentos compartidos y las conversaciones al margen sin revelar partes que aún no has leído.',datetime('now')),
 ('uib_es_es_v3','reader.social.signIn','Iniciar sesión',datetime('now')),
 ('uib_es_es_v3','reader.social.heading','Lectura social',datetime('now')),
 ('uib_es_es_v3','reader.social.description','Desactivada de forma predeterminada. El libro permanece despejado hasta que actives esta función.',datetime('now')),
 ('uib_es_es_v3','reader.social.enable','Activar la lectura social',datetime('now')),
 ('uib_es_es_v3','reader.social.audience','De quién ver la actividad',datetime('now')),
 ('uib_es_es_v3','reader.social.discussions','Debates',datetime('now')),
 ('uib_es_es_v3','reader.social.sharedHighlights','Fragmentos compartidos',datetime('now')),
 ('uib_es_es_v3','reader.social.reactions','Reacciones',datetime('now'));
UPDATE ui_translation_bundles SET status='retired' WHERE id='uib_es_es_v2';
UPDATE ui_translation_bundles SET status='active',message_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_es_es_v3'),translated_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_es_es_v3'),coverage_bps=10000,activated_at=datetime('now') WHERE id='uib_es_es_v3';

INSERT INTO ui_translation_bundles(id,locale,version,status,source,message_count,translated_count,coverage_bps,checksum_sha256,created_at,activated_at)
SELECT 'uib_fr_fr_v3','fr-FR',3,'draft','fore',0,0,0,'',datetime('now'),NULL
WHERE NOT EXISTS (SELECT 1 FROM ui_translation_bundles WHERE id='uib_fr_fr_v3');
INSERT OR IGNORE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at)
SELECT 'uib_fr_fr_v3',message_key,message_value,datetime('now') FROM ui_translation_messages WHERE bundle_id='uib_fr_fr_v2';
INSERT OR REPLACE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at) VALUES
 ('uib_fr_fr_v3','reader.social.guestTitle','Lisez aux côtés des personnes de votre choix.',datetime('now')),
 ('uib_fr_fr_v3','reader.social.guestDescription','Connectez-vous pour activer les passages surlignés et les échanges en marge sans dévoiler la suite.',datetime('now')),
 ('uib_fr_fr_v3','reader.social.signIn','Se connecter',datetime('now')),
 ('uib_fr_fr_v3','reader.social.heading','Lecture sociale',datetime('now')),
 ('uib_fr_fr_v3','reader.social.description','Désactivée par défaut. Le livre reste épuré jusqu’à ce que vous activiez cette fonction.',datetime('now')),
 ('uib_fr_fr_v3','reader.social.enable','Activer la lecture sociale',datetime('now')),
 ('uib_fr_fr_v3','reader.social.audience','Activité de qui',datetime('now')),
 ('uib_fr_fr_v3','reader.social.discussions','Discussions',datetime('now')),
 ('uib_fr_fr_v3','reader.social.sharedHighlights','Passages surlignés partagés',datetime('now')),
 ('uib_fr_fr_v3','reader.social.reactions','Réactions',datetime('now'));
UPDATE ui_translation_bundles SET status='retired' WHERE id='uib_fr_fr_v2';
UPDATE ui_translation_bundles SET status='active',message_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_fr_fr_v3'),translated_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_fr_fr_v3'),coverage_bps=10000,activated_at=datetime('now') WHERE id='uib_fr_fr_v3';

INSERT INTO ui_translation_bundles(id,locale,version,status,source,message_count,translated_count,coverage_bps,checksum_sha256,created_at,activated_at)
SELECT 'uib_de_de_v3','de-DE',3,'draft','fore',0,0,0,'',datetime('now'),NULL
WHERE NOT EXISTS (SELECT 1 FROM ui_translation_bundles WHERE id='uib_de_de_v3');
INSERT OR IGNORE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at)
SELECT 'uib_de_de_v3',message_key,message_value,datetime('now') FROM ui_translation_messages WHERE bundle_id='uib_de_de_v2';
INSERT OR REPLACE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at) VALUES
 ('uib_de_de_v3','reader.social.guestTitle','Lies gemeinsam mit Menschen deiner Wahl.',datetime('now')),
 ('uib_de_de_v3','reader.social.guestDescription','Melde dich an, um gemeinsame Markierungen und Randgespräche ohne Spoiler zu aktivieren.',datetime('now')),
 ('uib_de_de_v3','reader.social.signIn','Anmelden',datetime('now')),
 ('uib_de_de_v3','reader.social.heading','Gemeinsames Lesen',datetime('now')),
 ('uib_de_de_v3','reader.social.description','Standardmäßig deaktiviert. Das Buch bleibt übersichtlich, bis du diese Funktion aktivierst.',datetime('now')),
 ('uib_de_de_v3','reader.social.enable','Gemeinsames Lesen aktivieren',datetime('now')),
 ('uib_de_de_v3','reader.social.audience','Wessen Aktivitäten',datetime('now')),
 ('uib_de_de_v3','reader.social.discussions','Diskussionen',datetime('now')),
 ('uib_de_de_v3','reader.social.sharedHighlights','Geteilte Markierungen',datetime('now')),
 ('uib_de_de_v3','reader.social.reactions','Reaktionen',datetime('now'));
UPDATE ui_translation_bundles SET status='retired' WHERE id='uib_de_de_v2';
UPDATE ui_translation_bundles SET status='active',message_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_de_de_v3'),translated_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_de_de_v3'),coverage_bps=10000,activated_at=datetime('now') WHERE id='uib_de_de_v3';

INSERT INTO ui_translation_bundles(id,locale,version,status,source,message_count,translated_count,coverage_bps,checksum_sha256,created_at,activated_at)
SELECT 'uib_ar_sa_v3','ar-SA',3,'draft','fore',0,0,0,'',datetime('now'),NULL
WHERE NOT EXISTS (SELECT 1 FROM ui_translation_bundles WHERE id='uib_ar_sa_v3');
INSERT OR IGNORE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at)
SELECT 'uib_ar_sa_v3',message_key,message_value,datetime('now') FROM ui_translation_messages WHERE bundle_id='uib_ar_sa_v2';
INSERT OR REPLACE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at) VALUES
 ('uib_ar_sa_v3','reader.social.guestTitle','اقرأ برفقة من تختار.',datetime('now')),
 ('uib_ar_sa_v3','reader.social.guestDescription','سجّل الدخول لتفعيل المقاطع المميزة المشتركة والنقاشات الهامشية دون كشف أحداث لم تصل إليها.',datetime('now')),
 ('uib_ar_sa_v3','reader.social.signIn','تسجيل الدخول',datetime('now')),
 ('uib_ar_sa_v3','reader.social.heading','القراءة الاجتماعية',datetime('now')),
 ('uib_ar_sa_v3','reader.social.description','معطّلة افتراضيًا. تبقى صفحات الكتاب واضحة حتى تختار تفعيل هذه الميزة.',datetime('now')),
 ('uib_ar_sa_v3','reader.social.enable','تفعيل القراءة الاجتماعية',datetime('now')),
 ('uib_ar_sa_v3','reader.social.audience','نشاط من تريد رؤيته',datetime('now')),
 ('uib_ar_sa_v3','reader.social.discussions','النقاشات',datetime('now')),
 ('uib_ar_sa_v3','reader.social.sharedHighlights','المقاطع المميزة المشتركة',datetime('now')),
 ('uib_ar_sa_v3','reader.social.reactions','التفاعلات',datetime('now'));
UPDATE ui_translation_bundles SET status='retired' WHERE id='uib_ar_sa_v2';
UPDATE ui_translation_bundles SET status='active',message_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_ar_sa_v3'),translated_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_ar_sa_v3'),coverage_bps=10000,activated_at=datetime('now') WHERE id='uib_ar_sa_v3';


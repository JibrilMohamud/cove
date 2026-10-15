-- Expand localized account, library, reader and statistics labels in all five supported locales.
-- These are UI labels, not publisher legal terms or contractual translations.

-- en-US: retain reviewed existing translations, add reader/account/statistics labels.
INSERT INTO ui_translation_bundles(id,locale,version,status,source,message_count,translated_count,coverage_bps,checksum_sha256,created_at,activated_at)
SELECT 'uib_en_us_v2', 'en-US', 2, 'draft', 'fore', 0, 0, 0, '', datetime('now'), NULL
WHERE NOT EXISTS (SELECT 1 FROM ui_translation_bundles WHERE id='uib_en_us_v2');
INSERT OR IGNORE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at)
SELECT 'uib_en_us_v2', message_key,message_value,datetime('now') FROM ui_translation_messages WHERE bundle_id='uib_en_us_v1';
INSERT OR REPLACE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at) VALUES
 ('uib_en_us_v2','account.loading','Opening your reading room…',datetime('now')),
 ('uib_en_us_v2','account.loadingError','Your reading room needs a moment.',datetime('now')),
 ('uib_en_us_v2','account.signIn','Create an account or log in',datetime('now')),
 ('uib_en_us_v2','account.welcome','Make yourself at home.',datetime('now')),
 ('uib_en_us_v2','collection.loadingMore','Loading…',datetime('now')),
 ('uib_en_us_v2','collection.next','Next page',datetime('now')),
 ('uib_en_us_v2','collection.page','Page',datetime('now')),
 ('uib_en_us_v2','collection.pagination','Collection pages',datetime('now')),
 ('uib_en_us_v2','collection.previous','Previous page',datetime('now')),
 ('uib_en_us_v2','common.retry','Try again',datetime('now')),
 ('uib_en_us_v2','definitions.saved','Saved definitions',datetime('now')),
 ('uib_en_us_v2','library.all','All books',datetime('now')),
 ('uib_en_us_v2','library.browse','Browse the bookstore',datetime('now')),
 ('uib_en_us_v2','library.current','Currently reading',datetime('now')),
 ('uib_en_us_v2','library.finished','Finished',datetime('now')),
 ('uib_en_us_v2','library.reading','Reading',datetime('now')),
 ('uib_en_us_v2','library.want','Want to read',datetime('now')),
 ('uib_en_us_v2','reader.bookmarks','Your bookmarks',datetime('now')),
 ('uib_en_us_v2','reader.chapters','Chapters',datetime('now')),
 ('uib_en_us_v2','reader.find','Find in this book',datetime('now')),
 ('uib_en_us_v2','reader.loadingPassages','Loading passages…',datetime('now')),
 ('uib_en_us_v2','reader.morePassages','Load more saved passages',datetime('now')),
 ('uib_en_us_v2','reader.nextPage','Next page',datetime('now')),
 ('uib_en_us_v2','reader.previousPage','Previous page',datetime('now')),
 ('uib_en_us_v2','reader.savedPassages','Your saved passages',datetime('now')),
 ('uib_en_us_v2','reader.shareHighlight','Share this saved highlight',datetime('now')),
 ('uib_en_us_v2','stats.description','Time with books. Words discovered. Places your curiosity takes you.',datetime('now')),
 ('uib_en_us_v2','stats.export','Export my data',datetime('now')),
 ('uib_en_us_v2','stats.eyebrow','A READING LIFE, IN NUMBERS',datetime('now')),
 ('uib_en_us_v2','stats.heading','Your stats',datetime('now')),
 ('uib_en_us_v2','stats.period.30','Last 30 days',datetime('now')),
 ('uib_en_us_v2','stats.period.365','Last 365 days',datetime('now')),
 ('uib_en_us_v2','stats.period.7','Last 7 days',datetime('now')),
 ('uib_en_us_v2','stats.period.90','Last 90 days',datetime('now')),
 ('uib_en_us_v2','stats.period.all','All time',datetime('now')),
 ('uib_en_us_v2','stats.period.label','Statistics period',datetime('now')),
 ('uib_en_us_v2','stats.private','Private · visible only to you',datetime('now'));
UPDATE ui_translation_bundles SET status='retired' WHERE id='uib_en_us_v1';
UPDATE ui_translation_bundles SET status='active',message_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_en_us_v2'),translated_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_en_us_v2'),coverage_bps=10000,activated_at=datetime('now') WHERE id='uib_en_us_v2';

-- es-ES: retain reviewed existing translations, add reader/account/statistics labels.
INSERT INTO ui_translation_bundles(id,locale,version,status,source,message_count,translated_count,coverage_bps,checksum_sha256,created_at,activated_at)
SELECT 'uib_es_es_v2', 'es-ES', 2, 'draft', 'fore', 0, 0, 0, '', datetime('now'), NULL
WHERE NOT EXISTS (SELECT 1 FROM ui_translation_bundles WHERE id='uib_es_es_v2');
INSERT OR IGNORE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at)
SELECT 'uib_es_es_v2', message_key,message_value,datetime('now') FROM ui_translation_messages WHERE bundle_id='uib_es_es_v1';
INSERT OR REPLACE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at) VALUES
 ('uib_es_es_v2','account.loading','Abriendo tu espacio de lectura…',datetime('now')),
 ('uib_es_es_v2','account.loadingError','Tu espacio de lectura necesita un momento.',datetime('now')),
 ('uib_es_es_v2','account.signIn','Crea una cuenta o inicia sesión',datetime('now')),
 ('uib_es_es_v2','account.welcome','Siéntete como en casa.',datetime('now')),
 ('uib_es_es_v2','collection.loadingMore','Cargando…',datetime('now')),
 ('uib_es_es_v2','collection.next','Página siguiente',datetime('now')),
 ('uib_es_es_v2','collection.page','Página',datetime('now')),
 ('uib_es_es_v2','collection.pagination','Páginas de la colección',datetime('now')),
 ('uib_es_es_v2','collection.previous','Página anterior',datetime('now')),
 ('uib_es_es_v2','common.retry','Volver a intentar',datetime('now')),
 ('uib_es_es_v2','definitions.saved','Definiciones guardadas',datetime('now')),
 ('uib_es_es_v2','library.all','Todos los libros',datetime('now')),
 ('uib_es_es_v2','library.browse','Explorar la librería',datetime('now')),
 ('uib_es_es_v2','library.current','Leyendo ahora',datetime('now')),
 ('uib_es_es_v2','library.finished','Terminados',datetime('now')),
 ('uib_es_es_v2','library.reading','Leyendo',datetime('now')),
 ('uib_es_es_v2','library.want','Quiero leer',datetime('now')),
 ('uib_es_es_v2','reader.bookmarks','Tus marcadores',datetime('now')),
 ('uib_es_es_v2','reader.chapters','Capítulos',datetime('now')),
 ('uib_es_es_v2','reader.find','Buscar en este libro',datetime('now')),
 ('uib_es_es_v2','reader.loadingPassages','Cargando pasajes…',datetime('now')),
 ('uib_es_es_v2','reader.morePassages','Cargar más pasajes guardados',datetime('now')),
 ('uib_es_es_v2','reader.nextPage','Página siguiente',datetime('now')),
 ('uib_es_es_v2','reader.previousPage','Página anterior',datetime('now')),
 ('uib_es_es_v2','reader.savedPassages','Tus pasajes guardados',datetime('now')),
 ('uib_es_es_v2','reader.shareHighlight','Compartir este fragmento resaltado',datetime('now')),
 ('uib_es_es_v2','stats.description','Tiempo entre libros. Palabras descubiertas. Lugares a los que te lleva tu curiosidad.',datetime('now')),
 ('uib_es_es_v2','stats.export','Exportar mis datos',datetime('now')),
 ('uib_es_es_v2','stats.eyebrow','UNA VIDA DE LECTURA EN CIFRAS',datetime('now')),
 ('uib_es_es_v2','stats.heading','Tus estadísticas',datetime('now')),
 ('uib_es_es_v2','stats.period.30','Últimos 30 días',datetime('now')),
 ('uib_es_es_v2','stats.period.365','Últimos 365 días',datetime('now')),
 ('uib_es_es_v2','stats.period.7','Últimos 7 días',datetime('now')),
 ('uib_es_es_v2','stats.period.90','Últimos 90 días',datetime('now')),
 ('uib_es_es_v2','stats.period.all','Desde siempre',datetime('now')),
 ('uib_es_es_v2','stats.period.label','Período de estadísticas',datetime('now')),
 ('uib_es_es_v2','stats.private','Privado · solo tú puedes verlo',datetime('now'));
UPDATE ui_translation_bundles SET status='retired' WHERE id='uib_es_es_v1';
UPDATE ui_translation_bundles SET status='active',message_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_es_es_v2'),translated_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_es_es_v2'),coverage_bps=10000,activated_at=datetime('now') WHERE id='uib_es_es_v2';

-- fr-FR: retain reviewed existing translations, add reader/account/statistics labels.
INSERT INTO ui_translation_bundles(id,locale,version,status,source,message_count,translated_count,coverage_bps,checksum_sha256,created_at,activated_at)
SELECT 'uib_fr_fr_v2', 'fr-FR', 2, 'draft', 'fore', 0, 0, 0, '', datetime('now'), NULL
WHERE NOT EXISTS (SELECT 1 FROM ui_translation_bundles WHERE id='uib_fr_fr_v2');
INSERT OR IGNORE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at)
SELECT 'uib_fr_fr_v2', message_key,message_value,datetime('now') FROM ui_translation_messages WHERE bundle_id='uib_fr_fr_v1';
INSERT OR REPLACE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at) VALUES
 ('uib_fr_fr_v2','account.loading','Ouverture de votre espace de lecture…',datetime('now')),
 ('uib_fr_fr_v2','account.loadingError','Votre espace de lecture a besoin d’un instant.',datetime('now')),
 ('uib_fr_fr_v2','account.signIn','Créer un compte ou se connecter',datetime('now')),
 ('uib_fr_fr_v2','account.welcome','Faites comme chez vous.',datetime('now')),
 ('uib_fr_fr_v2','collection.loadingMore','Chargement…',datetime('now')),
 ('uib_fr_fr_v2','collection.next','Page suivante',datetime('now')),
 ('uib_fr_fr_v2','collection.page','Page',datetime('now')),
 ('uib_fr_fr_v2','collection.pagination','Pages de la collection',datetime('now')),
 ('uib_fr_fr_v2','collection.previous','Page précédente',datetime('now')),
 ('uib_fr_fr_v2','common.retry','Réessayer',datetime('now')),
 ('uib_fr_fr_v2','definitions.saved','Définitions enregistrées',datetime('now')),
 ('uib_fr_fr_v2','library.all','Tous les livres',datetime('now')),
 ('uib_fr_fr_v2','library.browse','Parcourir la librairie',datetime('now')),
 ('uib_fr_fr_v2','library.current','Lectures en cours',datetime('now')),
 ('uib_fr_fr_v2','library.finished','Terminés',datetime('now')),
 ('uib_fr_fr_v2','library.reading','En cours',datetime('now')),
 ('uib_fr_fr_v2','library.want','À lire',datetime('now')),
 ('uib_fr_fr_v2','reader.bookmarks','Vos marque-pages',datetime('now')),
 ('uib_fr_fr_v2','reader.chapters','Chapitres',datetime('now')),
 ('uib_fr_fr_v2','reader.find','Rechercher dans ce livre',datetime('now')),
 ('uib_fr_fr_v2','reader.loadingPassages','Chargement des passages…',datetime('now')),
 ('uib_fr_fr_v2','reader.morePassages','Charger d’autres passages enregistrés',datetime('now')),
 ('uib_fr_fr_v2','reader.nextPage','Page suivante',datetime('now')),
 ('uib_fr_fr_v2','reader.previousPage','Page précédente',datetime('now')),
 ('uib_fr_fr_v2','reader.savedPassages','Vos passages enregistrés',datetime('now')),
 ('uib_fr_fr_v2','reader.shareHighlight','Partager ce passage surligné',datetime('now')),
 ('uib_fr_fr_v2','stats.description','Du temps avec les livres. Des mots découverts. Des horizons à explorer.',datetime('now')),
 ('uib_fr_fr_v2','stats.export','Exporter mes données',datetime('now')),
 ('uib_fr_fr_v2','stats.eyebrow','UNE VIE DE LECTURE EN CHIFFRES',datetime('now')),
 ('uib_fr_fr_v2','stats.heading','Vos statistiques',datetime('now')),
 ('uib_fr_fr_v2','stats.period.30','30 derniers jours',datetime('now')),
 ('uib_fr_fr_v2','stats.period.365','365 derniers jours',datetime('now')),
 ('uib_fr_fr_v2','stats.period.7','7 derniers jours',datetime('now')),
 ('uib_fr_fr_v2','stats.period.90','90 derniers jours',datetime('now')),
 ('uib_fr_fr_v2','stats.period.all','Depuis le début',datetime('now')),
 ('uib_fr_fr_v2','stats.period.label','Période des statistiques',datetime('now')),
 ('uib_fr_fr_v2','stats.private','Privé · visible uniquement par vous',datetime('now'));
UPDATE ui_translation_bundles SET status='retired' WHERE id='uib_fr_fr_v1';
UPDATE ui_translation_bundles SET status='active',message_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_fr_fr_v2'),translated_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_fr_fr_v2'),coverage_bps=10000,activated_at=datetime('now') WHERE id='uib_fr_fr_v2';

-- de-DE: retain reviewed existing translations, add reader/account/statistics labels.
INSERT INTO ui_translation_bundles(id,locale,version,status,source,message_count,translated_count,coverage_bps,checksum_sha256,created_at,activated_at)
SELECT 'uib_de_de_v2', 'de-DE', 2, 'draft', 'fore', 0, 0, 0, '', datetime('now'), NULL
WHERE NOT EXISTS (SELECT 1 FROM ui_translation_bundles WHERE id='uib_de_de_v2');
INSERT OR IGNORE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at)
SELECT 'uib_de_de_v2', message_key,message_value,datetime('now') FROM ui_translation_messages WHERE bundle_id='uib_de_de_v1';
INSERT OR REPLACE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at) VALUES
 ('uib_de_de_v2','account.loading','Dein Lesebereich wird geöffnet…',datetime('now')),
 ('uib_de_de_v2','account.loadingError','Dein Lesebereich braucht einen Moment.',datetime('now')),
 ('uib_de_de_v2','account.signIn','Konto erstellen oder anmelden',datetime('now')),
 ('uib_de_de_v2','account.welcome','Fühl dich wie zu Hause.',datetime('now')),
 ('uib_de_de_v2','collection.loadingMore','Wird geladen…',datetime('now')),
 ('uib_de_de_v2','collection.next','Nächste Seite',datetime('now')),
 ('uib_de_de_v2','collection.page','Seite',datetime('now')),
 ('uib_de_de_v2','collection.pagination','Sammlungsseiten',datetime('now')),
 ('uib_de_de_v2','collection.previous','Vorherige Seite',datetime('now')),
 ('uib_de_de_v2','common.retry','Erneut versuchen',datetime('now')),
 ('uib_de_de_v2','definitions.saved','Gespeicherte Definitionen',datetime('now')),
 ('uib_de_de_v2','library.all','Alle Bücher',datetime('now')),
 ('uib_de_de_v2','library.browse','Buchhandlung durchsuchen',datetime('now')),
 ('uib_de_de_v2','library.current','Wird gerade gelesen',datetime('now')),
 ('uib_de_de_v2','library.finished','Abgeschlossen',datetime('now')),
 ('uib_de_de_v2','library.reading','Am Lesen',datetime('now')),
 ('uib_de_de_v2','library.want','Möchte ich lesen',datetime('now')),
 ('uib_de_de_v2','reader.bookmarks','Deine Lesezeichen',datetime('now')),
 ('uib_de_de_v2','reader.chapters','Kapitel',datetime('now')),
 ('uib_de_de_v2','reader.find','In diesem Buch suchen',datetime('now')),
 ('uib_de_de_v2','reader.loadingPassages','Textstellen werden geladen…',datetime('now')),
 ('uib_de_de_v2','reader.morePassages','Weitere gespeicherte Textstellen laden',datetime('now')),
 ('uib_de_de_v2','reader.nextPage','Nächste Seite',datetime('now')),
 ('uib_de_de_v2','reader.previousPage','Vorherige Seite',datetime('now')),
 ('uib_de_de_v2','reader.savedPassages','Deine gespeicherten Textstellen',datetime('now')),
 ('uib_de_de_v2','reader.shareHighlight','Diese Markierung teilen',datetime('now')),
 ('uib_de_de_v2','stats.description','Zeit mit Büchern. Entdeckte Wörter. Wohin dich deine Neugier führt.',datetime('now')),
 ('uib_de_de_v2','stats.export','Meine Daten exportieren',datetime('now')),
 ('uib_de_de_v2','stats.eyebrow','EIN LESELEBEN IN ZAHLEN',datetime('now')),
 ('uib_de_de_v2','stats.heading','Deine Statistiken',datetime('now')),
 ('uib_de_de_v2','stats.period.30','Letzte 30 Tage',datetime('now')),
 ('uib_de_de_v2','stats.period.365','Letzte 365 Tage',datetime('now')),
 ('uib_de_de_v2','stats.period.7','Letzte 7 Tage',datetime('now')),
 ('uib_de_de_v2','stats.period.90','Letzte 90 Tage',datetime('now')),
 ('uib_de_de_v2','stats.period.all','Gesamter Zeitraum',datetime('now')),
 ('uib_de_de_v2','stats.period.label','Statistikzeitraum',datetime('now')),
 ('uib_de_de_v2','stats.private','Privat · nur für dich sichtbar',datetime('now'));
UPDATE ui_translation_bundles SET status='retired' WHERE id='uib_de_de_v1';
UPDATE ui_translation_bundles SET status='active',message_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_de_de_v2'),translated_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_de_de_v2'),coverage_bps=10000,activated_at=datetime('now') WHERE id='uib_de_de_v2';

-- ar-SA: retain reviewed existing translations, add reader/account/statistics labels.
INSERT INTO ui_translation_bundles(id,locale,version,status,source,message_count,translated_count,coverage_bps,checksum_sha256,created_at,activated_at)
SELECT 'uib_ar_sa_v2', 'ar-SA', 2, 'draft', 'fore', 0, 0, 0, '', datetime('now'), NULL
WHERE NOT EXISTS (SELECT 1 FROM ui_translation_bundles WHERE id='uib_ar_sa_v2');
INSERT OR IGNORE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at)
SELECT 'uib_ar_sa_v2', message_key,message_value,datetime('now') FROM ui_translation_messages WHERE bundle_id='uib_ar_sa_v1';
INSERT OR REPLACE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at) VALUES
 ('uib_ar_sa_v2','account.loading','جارٍ فتح مساحة القراءة…',datetime('now')),
 ('uib_ar_sa_v2','account.loadingError','تحتاج مساحة القراءة إلى لحظة.',datetime('now')),
 ('uib_ar_sa_v2','account.signIn','أنشئ حسابًا أو سجّل الدخول',datetime('now')),
 ('uib_ar_sa_v2','account.welcome','اعتبر المكان مكانك.',datetime('now')),
 ('uib_ar_sa_v2','collection.loadingMore','جارٍ التحميل…',datetime('now')),
 ('uib_ar_sa_v2','collection.next','الصفحة التالية',datetime('now')),
 ('uib_ar_sa_v2','collection.page','صفحة',datetime('now')),
 ('uib_ar_sa_v2','collection.pagination','صفحات المجموعة',datetime('now')),
 ('uib_ar_sa_v2','collection.previous','الصفحة السابقة',datetime('now')),
 ('uib_ar_sa_v2','common.retry','حاول مرة أخرى',datetime('now')),
 ('uib_ar_sa_v2','definitions.saved','التعريفات المحفوظة',datetime('now')),
 ('uib_ar_sa_v2','library.all','جميع الكتب',datetime('now')),
 ('uib_ar_sa_v2','library.browse','تصفح متجر الكتب',datetime('now')),
 ('uib_ar_sa_v2','library.current','قيد القراءة',datetime('now')),
 ('uib_ar_sa_v2','library.finished','مكتملة',datetime('now')),
 ('uib_ar_sa_v2','library.reading','قيد القراءة',datetime('now')),
 ('uib_ar_sa_v2','library.want','أريد قراءته',datetime('now')),
 ('uib_ar_sa_v2','reader.bookmarks','علاماتك المرجعية',datetime('now')),
 ('uib_ar_sa_v2','reader.chapters','الفصول',datetime('now')),
 ('uib_ar_sa_v2','reader.find','ابحث في هذا الكتاب',datetime('now')),
 ('uib_ar_sa_v2','reader.loadingPassages','جارٍ تحميل المقاطع…',datetime('now')),
 ('uib_ar_sa_v2','reader.morePassages','تحميل المزيد من المقاطع المحفوظة',datetime('now')),
 ('uib_ar_sa_v2','reader.nextPage','الصفحة التالية',datetime('now')),
 ('uib_ar_sa_v2','reader.previousPage','الصفحة السابقة',datetime('now')),
 ('uib_ar_sa_v2','reader.savedPassages','مقاطعك المحفوظة',datetime('now')),
 ('uib_ar_sa_v2','reader.shareHighlight','مشاركة هذا المقطع المميز',datetime('now')),
 ('uib_ar_sa_v2','stats.description','وقت تقضيه مع الكتب. كلمات تكتشفها. وآفاق يصل إليها فضولك.',datetime('now')),
 ('uib_ar_sa_v2','stats.export','تصدير بياناتي',datetime('now')),
 ('uib_ar_sa_v2','stats.eyebrow','حياة القراءة بالأرقام',datetime('now')),
 ('uib_ar_sa_v2','stats.heading','إحصاءاتك',datetime('now')),
 ('uib_ar_sa_v2','stats.period.30','آخر 30 يومًا',datetime('now')),
 ('uib_ar_sa_v2','stats.period.365','آخر 365 يومًا',datetime('now')),
 ('uib_ar_sa_v2','stats.period.7','آخر 7 أيام',datetime('now')),
 ('uib_ar_sa_v2','stats.period.90','آخر 90 يومًا',datetime('now')),
 ('uib_ar_sa_v2','stats.period.all','كل الأوقات',datetime('now')),
 ('uib_ar_sa_v2','stats.period.label','الفترة الإحصائية',datetime('now')),
 ('uib_ar_sa_v2','stats.private','خاص · مرئي لك وحدك',datetime('now'));
UPDATE ui_translation_bundles SET status='retired' WHERE id='uib_ar_sa_v1';
UPDATE ui_translation_bundles SET status='active',message_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_ar_sa_v2'),translated_count=(SELECT COUNT(*) FROM ui_translation_messages WHERE bundle_id='uib_ar_sa_v2'),coverage_bps=10000,activated_at=datetime('now') WHERE id='uib_ar_sa_v2';

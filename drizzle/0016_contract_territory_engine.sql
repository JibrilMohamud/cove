-- Commercial territory-set, historical-market, contract-language, and overlap engine.
-- Territory sets are templates. Each grant snapshots its resolved countries so later set edits
-- cannot silently alter an executed license.

DROP VIEW IF EXISTS retail_product_availability;
DROP VIEW IF EXISTS product_channel_availability;

ALTER TABLE territories ADD COLUMN iso_status text NOT NULL DEFAULT 'official';
ALTER TABLE territories ADD COLUMN valid_from text;
ALTER TABLE territories ADD COLUMN valid_to text;
ALTER TABLE territories ADD COLUMN is_sellable integer NOT NULL DEFAULT 1;

-- Canonical ISO 3166-1 alpha-2 markets plus practical extensions/markers.
INSERT INTO territories(code,name,iso_status,is_sellable) VALUES
('AD','Andorra','official',1),
('AE','United Arab Emirates','official',1),
('AF','Afghanistan','official',1),
('AG','Antigua and Barbuda','official',1),
('AI','Anguilla','official',1),
('AL','Albania','official',1),
('AM','Armenia','official',1),
('AO','Angola','official',1),
('AQ','Antarctica','official',1),
('AR','Argentina','official',1),
('AS','American Samoa','official',1),
('AT','Austria','official',1),
('AU','Australia','official',1),
('AW','Aruba','official',1),
('AX','Åland Islands','official',1),
('AZ','Azerbaijan','official',1),
('BA','Bosnia and Herzegovina','official',1),
('BB','Barbados','official',1),
('BD','Bangladesh','official',1),
('BE','Belgium','official',1),
('BF','Burkina Faso','official',1),
('BG','Bulgaria','official',1),
('BH','Bahrain','official',1),
('BI','Burundi','official',1),
('BJ','Benin','official',1),
('BL','Saint Barthélemy','official',1),
('BM','Bermuda','official',1),
('BN','Brunei Darussalam','official',1),
('BO','Bolivia, Plurinational State of','official',1),
('BQ','Bonaire, Sint Eustatius and Saba','official',1),
('BR','Brazil','official',1),
('BS','Bahamas','official',1),
('BT','Bhutan','official',1),
('BV','Bouvet Island','official',1),
('BW','Botswana','official',1),
('BY','Belarus','official',1),
('BZ','Belize','official',1),
('CA','Canada','official',1),
('CC','Cocos (Keeling) Islands','official',1),
('CD','Congo, The Democratic Republic of the','official',1),
('CF','Central African Republic','official',1),
('CG','Congo','official',1),
('CH','Switzerland','official',1),
('CI','Côte d''Ivoire','official',1),
('CK','Cook Islands','official',1),
('CL','Chile','official',1),
('CM','Cameroon','official',1),
('CN','China','official',1),
('CO','Colombia','official',1),
('CR','Costa Rica','official',1),
('CU','Cuba','official',1),
('CV','Cabo Verde','official',1),
('CW','Curaçao','official',1),
('CX','Christmas Island','official',1),
('CY','Cyprus','official',1),
('CZ','Czechia','official',1),
('DE','Germany','official',1),
('DJ','Djibouti','official',1),
('DK','Denmark','official',1),
('DM','Dominica','official',1),
('DO','Dominican Republic','official',1),
('DZ','Algeria','official',1),
('EC','Ecuador','official',1),
('EE','Estonia','official',1),
('EG','Egypt','official',1),
('EH','Western Sahara','official',1),
('ER','Eritrea','official',1),
('ES','Spain','official',1),
('ET','Ethiopia','official',1),
('FI','Finland','official',1),
('FJ','Fiji','official',1),
('FK','Falkland Islands (Malvinas)','official',1),
('FM','Micronesia, Federated States of','official',1),
('FO','Faroe Islands','official',1),
('FR','France','official',1),
('GA','Gabon','official',1),
('GB','United Kingdom','official',1),
('GD','Grenada','official',1),
('GE','Georgia','official',1),
('GF','French Guiana','official',1),
('GG','Guernsey','official',1),
('GH','Ghana','official',1),
('GI','Gibraltar','official',1),
('GL','Greenland','official',1),
('GM','Gambia','official',1),
('GN','Guinea','official',1),
('GP','Guadeloupe','official',1),
('GQ','Equatorial Guinea','official',1),
('GR','Greece','official',1),
('GS','South Georgia and the South Sandwich Islands','official',1),
('GT','Guatemala','official',1),
('GU','Guam','official',1),
('GW','Guinea-Bissau','official',1),
('GY','Guyana','official',1),
('HK','Hong Kong','official',1),
('HM','Heard Island and McDonald Islands','official',1),
('HN','Honduras','official',1),
('HR','Croatia','official',1),
('HT','Haiti','official',1),
('HU','Hungary','official',1),
('ID','Indonesia','official',1),
('IE','Ireland','official',1),
('IL','Israel','official',1),
('IM','Isle of Man','official',1),
('IN','India','official',1),
('IO','British Indian Ocean Territory','official',1),
('IQ','Iraq','official',1),
('IR','Iran, Islamic Republic of','official',1),
('IS','Iceland','official',1),
('IT','Italy','official',1),
('JE','Jersey','official',1),
('JM','Jamaica','official',1),
('JO','Jordan','official',1),
('JP','Japan','official',1),
('KE','Kenya','official',1),
('KG','Kyrgyzstan','official',1),
('KH','Cambodia','official',1),
('KI','Kiribati','official',1),
('KM','Comoros','official',1),
('KN','Saint Kitts and Nevis','official',1),
('KP','Korea, Democratic People''s Republic of','official',1),
('KR','Korea, Republic of','official',1),
('KW','Kuwait','official',1),
('KY','Cayman Islands','official',1),
('KZ','Kazakhstan','official',1),
('LA','Lao People''s Democratic Republic','official',1),
('LB','Lebanon','official',1),
('LC','Saint Lucia','official',1),
('LI','Liechtenstein','official',1),
('LK','Sri Lanka','official',1),
('LR','Liberia','official',1),
('LS','Lesotho','official',1),
('LT','Lithuania','official',1),
('LU','Luxembourg','official',1),
('LV','Latvia','official',1),
('LY','Libya','official',1),
('MA','Morocco','official',1),
('MC','Monaco','official',1),
('MD','Moldova, Republic of','official',1),
('ME','Montenegro','official',1),
('MF','Saint Martin (French part)','official',1),
('MG','Madagascar','official',1),
('MH','Marshall Islands','official',1),
('MK','North Macedonia','official',1),
('ML','Mali','official',1),
('MM','Myanmar','official',1),
('MN','Mongolia','official',1),
('MO','Macao','official',1),
('MP','Northern Mariana Islands','official',1),
('MQ','Martinique','official',1),
('MR','Mauritania','official',1),
('MS','Montserrat','official',1),
('MT','Malta','official',1),
('MU','Mauritius','official',1),
('MV','Maldives','official',1),
('MW','Malawi','official',1),
('MX','Mexico','official',1),
('MY','Malaysia','official',1),
('MZ','Mozambique','official',1),
('NA','Namibia','official',1),
('NC','New Caledonia','official',1),
('NE','Niger','official',1),
('NF','Norfolk Island','official',1),
('NG','Nigeria','official',1),
('NI','Nicaragua','official',1),
('NL','Netherlands','official',1),
('NO','Norway','official',1),
('NP','Nepal','official',1),
('NR','Nauru','official',1),
('NU','Niue','official',1),
('NZ','New Zealand','official',1),
('OM','Oman','official',1),
('PA','Panama','official',1),
('PE','Peru','official',1),
('PF','French Polynesia','official',1),
('PG','Papua New Guinea','official',1),
('PH','Philippines','official',1),
('PK','Pakistan','official',1),
('PL','Poland','official',1),
('PM','Saint Pierre and Miquelon','official',1),
('PN','Pitcairn','official',1),
('PR','Puerto Rico','official',1),
('PS','Palestine, State of','official',1),
('PT','Portugal','official',1),
('PW','Palau','official',1),
('PY','Paraguay','official',1),
('QA','Qatar','official',1),
('RE','Réunion','official',1),
('RO','Romania','official',1),
('RS','Serbia','official',1),
('RU','Russian Federation','official',1),
('RW','Rwanda','official',1),
('SA','Saudi Arabia','official',1),
('SB','Solomon Islands','official',1),
('SC','Seychelles','official',1),
('SD','Sudan','official',1),
('SE','Sweden','official',1),
('SG','Singapore','official',1),
('SH','Saint Helena, Ascension and Tristan da Cunha','official',1),
('SI','Slovenia','official',1),
('SJ','Svalbard and Jan Mayen','official',1),
('SK','Slovakia','official',1),
('SL','Sierra Leone','official',1),
('SM','San Marino','official',1),
('SN','Senegal','official',1),
('SO','Somalia','official',1),
('SR','Suriname','official',1),
('SS','South Sudan','official',1),
('ST','Sao Tome and Principe','official',1),
('SV','El Salvador','official',1),
('SX','Sint Maarten (Dutch part)','official',1),
('SY','Syrian Arab Republic','official',1),
('SZ','Eswatini','official',1),
('TC','Turks and Caicos Islands','official',1),
('TD','Chad','official',1),
('TF','French Southern Territories','official',1),
('TG','Togo','official',1),
('TH','Thailand','official',1),
('TJ','Tajikistan','official',1),
('TK','Tokelau','official',1),
('TL','Timor-Leste','official',1),
('TM','Turkmenistan','official',1),
('TN','Tunisia','official',1),
('TO','Tonga','official',1),
('TR','Türkiye','official',1),
('TT','Trinidad and Tobago','official',1),
('TV','Tuvalu','official',1),
('TW','Taiwan, Province of China','official',1),
('TZ','Tanzania, United Republic of','official',1),
('UA','Ukraine','official',1),
('UG','Uganda','official',1),
('UM','United States Minor Outlying Islands','official',1),
('US','United States','official',1),
('UY','Uruguay','official',1),
('UZ','Uzbekistan','official',1),
('VA','Holy See (Vatican City State)','official',1),
('VC','Saint Vincent and the Grenadines','official',1),
('VE','Venezuela, Bolivarian Republic of','official',1),
('VG','Virgin Islands, British','official',1),
('VI','Virgin Islands, U.S.','official',1),
('VN','Viet Nam','official',1),
('VU','Vanuatu','official',1),
('WF','Wallis and Futuna','official',1),
('WS','Samoa','official',1),
('YE','Yemen','official',1),
('YT','Mayotte','official',1),
('ZA','South Africa','official',1),
('ZM','Zambia','official',1),
('ZW','Zimbabwe','official',1)
ON CONFLICT(code) DO UPDATE SET name=excluded.name,iso_status='official',is_sellable=1;
INSERT INTO territories(code,name,iso_status,is_sellable) VALUES
('XK','Kosovo','user-assigned',1),
('ZZ','Multiple territories (internal scope marker)','internal',0),
('UK','United Kingdom (legacy alias)','alias',0)
ON CONFLICT(code) DO UPDATE SET name=excluded.name,iso_status=excluded.iso_status,is_sellable=excluded.is_sellable;

CREATE TABLE territory_aliases (
  alias_code text PRIMARY KEY,
  territory_code text NOT NULL REFERENCES territories(code) ON DELETE RESTRICT,
  alias_type text NOT NULL DEFAULT 'common',
  notes text NOT NULL DEFAULT ''
);
INSERT OR REPLACE INTO territory_aliases(alias_code,territory_code,alias_type,notes) VALUES
('UK','GB','common','Common publishing/storefront alias for ISO GB.'),
('EL','GR','common','Common EU institutional abbreviation for Greece; ISO alpha-2 is GR.');

CREATE TABLE territory_historical_entities (
  id text PRIMARY KEY,
  historical_code text NOT NULL,
  name text NOT NULL,
  valid_from text,
  valid_to text,
  notes text NOT NULL DEFAULT ''
);
CREATE INDEX idx_territory_historical_code ON territory_historical_entities(historical_code,valid_from,valid_to);
CREATE TABLE territory_historical_successors (
  historical_entity_id text NOT NULL REFERENCES territory_historical_entities(id) ON DELETE CASCADE,
  territory_code text NOT NULL REFERENCES territories(code) ON DELETE RESTRICT,
  relationship text NOT NULL DEFAULT 'successor-market',
  PRIMARY KEY(historical_entity_id,territory_code)
);
INSERT INTO territory_historical_entities(id,historical_code,name,valid_from,valid_to,notes) VALUES
('hist_su','SU','Soviet Union','1922-12-30','1991-12-26','Successor-market mapping for contract interpretation; review counsel for disputed or period-specific rights.'),
('hist_yu','YU','Yugoslavia','1918-12-01','1992-04-27','Successor-market mapping; territorial succession does not itself determine copyright ownership.'),
('hist_cs_czsk','CS','Czechoslovakia','1918-10-28','1992-12-31','The code CS is historically ambiguous; supply an as-of date when expanding.'),
('hist_cs_scm','CS','Serbia and Montenegro','2003-02-04','2006-06-05','The code CS was reused; supply an as-of date when expanding.'),
('hist_an','AN','Netherlands Antilles','1954-12-15','2010-10-10','Successor-market mapping.'),
('hist_tp','TP','East Timor (former code)','1975-01-01','2002-05-19','Former ISO code mapped to Timor-Leste.'),
('hist_zr','ZR','Zaire','1971-10-27','1997-05-17','Former ISO code mapped to Democratic Republic of the Congo.'),
('hist_bu','BU','Burma (former code)','1948-01-04','1989-06-18','Former code/name mapped to Myanmar for modern market expansion.'),
('hist_dd','DD','German Democratic Republic','1949-10-07','1990-10-03','Former East Germany mapped to modern Germany for market expansion.');
INSERT INTO territory_historical_successors(historical_entity_id,territory_code,relationship) VALUES
('hist_su','AM','successor-market'),
('hist_su','AZ','successor-market'),
('hist_su','BY','successor-market'),
('hist_su','EE','successor-market'),
('hist_su','GE','successor-market'),
('hist_su','KZ','successor-market'),
('hist_su','KG','successor-market'),
('hist_su','LV','successor-market'),
('hist_su','LT','successor-market'),
('hist_su','MD','successor-market'),
('hist_su','RU','successor-market'),
('hist_su','TJ','successor-market'),
('hist_su','TM','successor-market'),
('hist_su','UA','successor-market'),
('hist_su','UZ','successor-market'),
('hist_yu','BA','successor-market'),
('hist_yu','HR','successor-market'),
('hist_yu','ME','successor-market'),
('hist_yu','MK','successor-market'),
('hist_yu','RS','successor-market'),
('hist_yu','SI','successor-market'),
('hist_yu','XK','successor-market'),
('hist_cs_czsk','CZ','successor-market'),
('hist_cs_czsk','SK','successor-market'),
('hist_cs_scm','ME','successor-market'),
('hist_cs_scm','RS','successor-market'),
('hist_an','BQ','successor-market'),
('hist_an','CW','successor-market'),
('hist_an','SX','successor-market'),
('hist_tp','TL','successor-market'),
('hist_zr','CD','successor-market'),
('hist_bu','MM','successor-market'),
('hist_dd','DE','successor-market');

CREATE TABLE territory_sets (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  set_type text NOT NULL DEFAULT 'custom' CHECK(set_type IN ('custom','region','market','worldwide')),
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','archived')),
  is_system integer NOT NULL DEFAULT 0,
  as_of_date text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE TABLE territory_set_rules (
  id text PRIMARY KEY,
  set_id text NOT NULL REFERENCES territory_sets(id) ON DELETE CASCADE,
  effect text NOT NULL CHECK(effect IN ('include','exclude')),
  target_type text NOT NULL CHECK(target_type IN ('territory','set','historical')),
  territory_code text REFERENCES territories(code) ON DELETE RESTRICT,
  target_set_id text REFERENCES territory_sets(id) ON DELETE RESTRICT,
  historical_code text,
  position integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  CHECK((target_type='territory' AND territory_code IS NOT NULL AND target_set_id IS NULL AND historical_code IS NULL)
     OR (target_type='set' AND territory_code IS NULL AND target_set_id IS NOT NULL AND historical_code IS NULL)
     OR (target_type='historical' AND territory_code IS NULL AND target_set_id IS NULL AND historical_code IS NOT NULL))
);
CREATE INDEX idx_territory_set_rules_set ON territory_set_rules(set_id,effect,position);
CREATE TABLE territory_set_members (
  set_id text NOT NULL REFERENCES territory_sets(id) ON DELETE CASCADE,
  territory_code text NOT NULL REFERENCES territories(code) ON DELETE RESTRICT,
  resolution_source text NOT NULL DEFAULT '',
  resolved_at text NOT NULL,
  PRIMARY KEY(set_id,territory_code)
);
CREATE INDEX idx_territory_set_members_territory ON territory_set_members(territory_code,set_id);

INSERT INTO territory_sets(id,code,name,set_type,description,status,is_system,created_at,updated_at) VALUES
('rset_world','WORLD','Worldwide','worldwide','All currently sellable ISO markets plus explicitly supported user-assigned commerce markets.','active',1,datetime('now'),datetime('now')),
('rset_eu','EU','European Union','region','Current EU member-state market template.','active',1,datetime('now'),datetime('now')),
('rset_eea','EEA','European Economic Area','region','EU plus Iceland, Liechtenstein and Norway.','active',1,datetime('now'),datetime('now')),
('rset_anz','ANZ','Australia + New Zealand','market','Common two-market publishing template.','active',1,datetime('now'),datetime('now')),
('rset_us_ca','US_CA','United States + Canada','market','North American two-market publishing template.','active',1,datetime('now'),datetime('now')),
('rset_gb_ie','GB_IE','United Kingdom + Ireland','market','GB and Ireland publishing template.','active',1,datetime('now'),datetime('now'));
INSERT INTO territory_set_rules(id,set_id,effect,target_type,territory_code,target_set_id,historical_code,position,created_at) VALUES
('tsr_rset_eu_include_territory_at','rset_eu','include','territory','AT',NULL,NULL,0,datetime('now')),
('tsr_rset_eu_include_territory_be','rset_eu','include','territory','BE',NULL,NULL,1,datetime('now')),
('tsr_rset_eu_include_territory_bg','rset_eu','include','territory','BG',NULL,NULL,2,datetime('now')),
('tsr_rset_eu_include_territory_hr','rset_eu','include','territory','HR',NULL,NULL,3,datetime('now')),
('tsr_rset_eu_include_territory_cy','rset_eu','include','territory','CY',NULL,NULL,4,datetime('now')),
('tsr_rset_eu_include_territory_cz','rset_eu','include','territory','CZ',NULL,NULL,5,datetime('now')),
('tsr_rset_eu_include_territory_dk','rset_eu','include','territory','DK',NULL,NULL,6,datetime('now')),
('tsr_rset_eu_include_territory_ee','rset_eu','include','territory','EE',NULL,NULL,7,datetime('now')),
('tsr_rset_eu_include_territory_fi','rset_eu','include','territory','FI',NULL,NULL,8,datetime('now')),
('tsr_rset_eu_include_territory_fr','rset_eu','include','territory','FR',NULL,NULL,9,datetime('now')),
('tsr_rset_eu_include_territory_de','rset_eu','include','territory','DE',NULL,NULL,10,datetime('now')),
('tsr_rset_eu_include_territory_gr','rset_eu','include','territory','GR',NULL,NULL,11,datetime('now')),
('tsr_rset_eu_include_territory_hu','rset_eu','include','territory','HU',NULL,NULL,12,datetime('now')),
('tsr_rset_eu_include_territory_ie','rset_eu','include','territory','IE',NULL,NULL,13,datetime('now')),
('tsr_rset_eu_include_territory_it','rset_eu','include','territory','IT',NULL,NULL,14,datetime('now')),
('tsr_rset_eu_include_territory_lv','rset_eu','include','territory','LV',NULL,NULL,15,datetime('now')),
('tsr_rset_eu_include_territory_lt','rset_eu','include','territory','LT',NULL,NULL,16,datetime('now')),
('tsr_rset_eu_include_territory_lu','rset_eu','include','territory','LU',NULL,NULL,17,datetime('now')),
('tsr_rset_eu_include_territory_mt','rset_eu','include','territory','MT',NULL,NULL,18,datetime('now')),
('tsr_rset_eu_include_territory_nl','rset_eu','include','territory','NL',NULL,NULL,19,datetime('now')),
('tsr_rset_eu_include_territory_pl','rset_eu','include','territory','PL',NULL,NULL,20,datetime('now')),
('tsr_rset_eu_include_territory_pt','rset_eu','include','territory','PT',NULL,NULL,21,datetime('now')),
('tsr_rset_eu_include_territory_ro','rset_eu','include','territory','RO',NULL,NULL,22,datetime('now')),
('tsr_rset_eu_include_territory_sk','rset_eu','include','territory','SK',NULL,NULL,23,datetime('now')),
('tsr_rset_eu_include_territory_si','rset_eu','include','territory','SI',NULL,NULL,24,datetime('now')),
('tsr_rset_eu_include_territory_es','rset_eu','include','territory','ES',NULL,NULL,25,datetime('now')),
('tsr_rset_eu_include_territory_se','rset_eu','include','territory','SE',NULL,NULL,26,datetime('now')),
('tsr_rset_eea_include_set_rset_eu','rset_eea','include','set',NULL,'rset_eu',NULL,0,datetime('now')),
('tsr_rset_eea_include_territory_is','rset_eea','include','territory','IS',NULL,NULL,1,datetime('now')),
('tsr_rset_eea_include_territory_li','rset_eea','include','territory','LI',NULL,NULL,2,datetime('now')),
('tsr_rset_eea_include_territory_no','rset_eea','include','territory','NO',NULL,NULL,3,datetime('now')),
('tsr_rset_anz_include_territory_au','rset_anz','include','territory','AU',NULL,NULL,0,datetime('now')),
('tsr_rset_anz_include_territory_nz','rset_anz','include','territory','NZ',NULL,NULL,1,datetime('now')),
('tsr_rset_us_ca_include_territory_us','rset_us_ca','include','territory','US',NULL,NULL,0,datetime('now')),
('tsr_rset_us_ca_include_territory_ca','rset_us_ca','include','territory','CA',NULL,NULL,1,datetime('now')),
('tsr_rset_gb_ie_include_territory_gb','rset_gb_ie','include','territory','GB',NULL,NULL,0,datetime('now')),
('tsr_rset_gb_ie_include_territory_ie','rset_gb_ie','include','territory','IE',NULL,NULL,1,datetime('now'));
INSERT INTO territory_set_members(set_id,territory_code,resolution_source,resolved_at)
SELECT 'rset_world',code,'system:WORLD',datetime('now') FROM territories WHERE is_sellable=1;
INSERT INTO territory_set_members(set_id,territory_code,resolution_source,resolved_at)
SELECT 'rset_eu',territory_code,'system:EU',datetime('now') FROM territory_set_rules WHERE set_id='rset_eu' AND target_type='territory' AND effect='include';
INSERT INTO territory_set_members(set_id,territory_code,resolution_source,resolved_at)
SELECT 'rset_eea',territory_code,'system:EEA',datetime('now') FROM territory_set_members WHERE set_id='rset_eu';
INSERT OR IGNORE INTO territory_set_members(set_id,territory_code,resolution_source,resolved_at)
SELECT 'rset_eea',territory_code,'system:EEA',datetime('now') FROM territory_set_rules WHERE set_id='rset_eea' AND target_type='territory' AND effect='include';
INSERT INTO territory_set_members(set_id,territory_code,resolution_source,resolved_at)
SELECT 'rset_anz',territory_code,'system:ANZ',datetime('now') FROM territory_set_rules WHERE set_id='rset_anz' AND target_type='territory' AND effect='include';
INSERT INTO territory_set_members(set_id,territory_code,resolution_source,resolved_at)
SELECT 'rset_us_ca',territory_code,'system:US_CA',datetime('now') FROM territory_set_rules WHERE set_id='rset_us_ca' AND target_type='territory' AND effect='include';
INSERT INTO territory_set_members(set_id,territory_code,resolution_source,resolved_at)
SELECT 'rset_gb_ie',territory_code,'system:GB_IE',datetime('now') FROM territory_set_rules WHERE set_id='rset_gb_ie' AND target_type='territory' AND effect='include';

CREATE TABLE rights_contracts (
  id text PRIMARY KEY,
  reference_code text NOT NULL UNIQUE,
  name text NOT NULL,
  rightsholder_party_id text REFERENCES rights_parties(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','suspended','expired','terminated')),
  effective_from text,
  effective_to text,
  language_match_mode text NOT NULL DEFAULT 'all' CHECK(language_match_mode IN ('any','all')),
  source text NOT NULL DEFAULT 'operator',
  notes text NOT NULL DEFAULT '',
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX idx_rights_contracts_party ON rights_contracts(rightsholder_party_id,status,effective_from,effective_to);
CREATE TABLE rights_contract_languages (
  id text PRIMARY KEY,
  contract_id text NOT NULL REFERENCES rights_contracts(id) ON DELETE CASCADE,
  language_code text NOT NULL,
  decision text NOT NULL DEFAULT 'allow' CHECK(decision IN ('allow','deny')),
  format text,
  sales_channel text CHECK(sales_channel IS NULL OR sales_channel IN ('retail','subscription','library')),
  starts_at text,
  ends_at text,
  notes text NOT NULL DEFAULT '',
  created_at text NOT NULL
);
CREATE INDEX idx_rights_contract_languages_match ON rights_contract_languages(contract_id,language_code,decision,format,sales_channel,starts_at,ends_at);

ALTER TABLE rights_grants ADD COLUMN contract_id text REFERENCES rights_contracts(id) ON DELETE RESTRICT;
ALTER TABLE rights_grants ADD COLUMN exclusivity text NOT NULL DEFAULT 'nonexclusive' CHECK(exclusivity IN ('nonexclusive','exclusive','sole'));
ALTER TABLE rights_grants ADD COLUMN scope_summary text NOT NULL DEFAULT '';
ALTER TABLE rights_decisions ADD COLUMN contract_id text;
ALTER TABLE rights_decisions ADD COLUMN scope_summary text NOT NULL DEFAULT '';
ALTER TABLE rights_decisions ADD COLUMN exclusivity text NOT NULL DEFAULT 'nonexclusive';
ALTER TABLE rights_decisions ADD COLUMN language_rights_json text NOT NULL DEFAULT '{}';
CREATE INDEX idx_rights_grant_contract ON rights_grants(contract_id,status,edition_id,format,sales_channel);

CREATE TABLE rights_grant_territory_scopes (
  id text PRIMARY KEY,
  grant_id text NOT NULL REFERENCES rights_grants(id) ON DELETE CASCADE,
  effect text NOT NULL CHECK(effect IN ('include','exclude')),
  target_type text NOT NULL CHECK(target_type IN ('territory','set','historical')),
  territory_code text REFERENCES territories(code) ON DELETE RESTRICT,
  territory_set_id text REFERENCES territory_sets(id) ON DELETE RESTRICT,
  historical_code text,
  as_of_date text,
  position integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  CHECK((target_type='territory' AND territory_code IS NOT NULL AND territory_set_id IS NULL AND historical_code IS NULL)
     OR (target_type='set' AND territory_code IS NULL AND territory_set_id IS NOT NULL AND historical_code IS NULL)
     OR (target_type='historical' AND territory_code IS NULL AND territory_set_id IS NULL AND historical_code IS NOT NULL))
);
CREATE INDEX idx_rights_grant_scopes_grant ON rights_grant_territory_scopes(grant_id,effect,position);
CREATE TABLE rights_grant_territories (
  grant_id text NOT NULL REFERENCES rights_grants(id) ON DELETE CASCADE,
  territory_code text NOT NULL REFERENCES territories(code) ON DELETE RESTRICT,
  resolved_from text NOT NULL DEFAULT '',
  snapshotted_at text NOT NULL,
  PRIMARY KEY(grant_id,territory_code)
);
CREATE INDEX idx_rights_grant_territories_lookup ON rights_grant_territories(territory_code,grant_id);
CREATE TABLE rights_grant_scope_snapshots (
  id text PRIMARY KEY,
  grant_id text NOT NULL,
  scope_json text NOT NULL,
  territories_json text NOT NULL,
  recorded_at text NOT NULL
);
CREATE INDEX idx_rights_scope_snapshots_grant ON rights_grant_scope_snapshots(grant_id,recorded_at DESC);

CREATE TABLE rights_configuration_audit (
  id text PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  snapshot_json text NOT NULL,
  recorded_at text NOT NULL
);
CREATE INDEX idx_rights_configuration_audit_entity ON rights_configuration_audit(entity_type,entity_id,recorded_at DESC);

-- Backfill exact legacy single-country grants into immutable-at-decision-time grant snapshots.
INSERT OR IGNORE INTO rights_grant_territory_scopes(id,grant_id,effect,target_type,territory_code,position,created_at)
SELECT 'rgscope_legacy_'||rg.id,rg.id,'include','territory',COALESCE(ta.territory_code,upper(rg.territory_code)),0,COALESCE(rg.updated_at,rg.created_at)
FROM rights_grants rg LEFT JOIN territory_aliases ta ON ta.alias_code=upper(rg.territory_code)
WHERE rg.territory_code<>'ZZ';
INSERT OR IGNORE INTO rights_grant_territories(grant_id,territory_code,resolved_from,snapshotted_at)
SELECT rg.id,COALESCE(ta.territory_code,upper(rg.territory_code)),'legacy:'||upper(rg.territory_code),COALESCE(rg.updated_at,rg.created_at)
FROM rights_grants rg LEFT JOIN territory_aliases ta ON ta.alias_code=upper(rg.territory_code)
WHERE rg.territory_code<>'ZZ';
INSERT INTO rights_grant_scope_snapshots(id,grant_id,scope_json,territories_json,recorded_at)
SELECT 'rgss_'||lower(hex(randomblob(16))),rg.id,
  json_object('mode','legacy-single','territory',rg.territory_code),
  COALESCE((SELECT json_group_array(territory_code) FROM rights_grant_territories t WHERE t.grant_id=rg.id),'[]'),
  COALESCE(rg.updated_at,rg.created_at)
FROM rights_grants rg;

-- Legacy direct INSERTs (including ingestion code) continue to work after this migration.
CREATE TRIGGER rights_grants_scope_legacy_insert AFTER INSERT ON rights_grants
WHEN NEW.territory_code<>'ZZ' BEGIN
  INSERT OR IGNORE INTO rights_grant_territory_scopes(id,grant_id,effect,target_type,territory_code,position,created_at)
  VALUES('rgscope_legacy_'||NEW.id,NEW.id,'include','territory',COALESCE((SELECT territory_code FROM territory_aliases WHERE alias_code=upper(NEW.territory_code)),upper(NEW.territory_code)),0,COALESCE(NEW.updated_at,NEW.created_at));
  INSERT OR IGNORE INTO rights_grant_territories(grant_id,territory_code,resolved_from,snapshotted_at)
  VALUES(NEW.id,COALESCE((SELECT territory_code FROM territory_aliases WHERE alias_code=upper(NEW.territory_code)),upper(NEW.territory_code)),'legacy:'||upper(NEW.territory_code),COALESCE(NEW.updated_at,NEW.created_at));
END;

DROP TRIGGER IF EXISTS rights_grants_audit_insert;
DROP TRIGGER IF EXISTS rights_grants_audit_update;
CREATE TRIGGER rights_grants_audit_insert AFTER INSERT ON rights_grants BEGIN
  INSERT INTO rights_grant_audit(id,grant_id,action,snapshot_json,recorded_at) VALUES(
    'rga_'||lower(hex(randomblob(16))),NEW.id,'insert',json_object(
      'editionId',NEW.edition_id,'rightsholderId',NEW.rightsholder_id,'rightsholderPartyId',NEW.rightsholder_party_id,
      'territory',NEW.territory_code,'scopeSummary',NEW.scope_summary,'format',NEW.format,'salesChannel',NEW.sales_channel,'startsAt',NEW.starts_at,'endsAt',NEW.ends_at,
      'licenseType',NEW.license_type,'contractId',NEW.contract_id,'exclusivity',NEW.exclusivity,'drmRequirement',NEW.drm_requirement,
      'subscriptionPermitted',NEW.subscription_permitted,'libraryPermitted',NEW.library_permitted,'decision',NEW.decision,'status',NEW.status,
      'promotionRestrictions',CASE WHEN json_valid(NEW.promotion_restrictions_json) THEN json(NEW.promotion_restrictions_json) ELSE json('{}') END,
      'contractReference',NEW.contract_reference,'source',NEW.source,'notes',NEW.notes
    ),COALESCE(NEW.updated_at,NEW.created_at));
END;
CREATE TRIGGER rights_grants_audit_update AFTER UPDATE ON rights_grants BEGIN
  INSERT INTO rights_grant_audit(id,grant_id,action,snapshot_json,recorded_at) VALUES(
    'rga_'||lower(hex(randomblob(16))),NEW.id,'update',json_object(
      'editionId',NEW.edition_id,'rightsholderId',NEW.rightsholder_id,'rightsholderPartyId',NEW.rightsholder_party_id,
      'territory',NEW.territory_code,'scopeSummary',NEW.scope_summary,'format',NEW.format,'salesChannel',NEW.sales_channel,'startsAt',NEW.starts_at,'endsAt',NEW.ends_at,
      'licenseType',NEW.license_type,'contractId',NEW.contract_id,'exclusivity',NEW.exclusivity,'drmRequirement',NEW.drm_requirement,
      'subscriptionPermitted',NEW.subscription_permitted,'libraryPermitted',NEW.library_permitted,'decision',NEW.decision,'status',NEW.status,
      'promotionRestrictions',CASE WHEN json_valid(NEW.promotion_restrictions_json) THEN json(NEW.promotion_restrictions_json) ELSE json('{}') END,
      'contractReference',NEW.contract_reference,'source',NEW.source,'notes',NEW.notes
    ),COALESCE(NEW.updated_at,datetime('now')));
END;
CREATE TRIGGER rights_grants_contract_insert BEFORE INSERT ON rights_grants
WHEN NEW.contract_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rights_contracts WHERE id=NEW.contract_id) BEGIN
  SELECT RAISE(ABORT,'unknown rights contract');
END;
CREATE TRIGGER rights_grants_contract_update BEFORE UPDATE OF contract_id ON rights_grants
WHEN NEW.contract_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rights_contracts WHERE id=NEW.contract_id) BEGIN
  SELECT RAISE(ABORT,'unknown rights contract');
END;
CREATE TRIGGER rights_scope_snapshots_no_update BEFORE UPDATE ON rights_grant_scope_snapshots BEGIN SELECT RAISE(ABORT,'rights scope snapshots are append-only'); END;
CREATE TRIGGER rights_scope_snapshots_no_delete BEFORE DELETE ON rights_grant_scope_snapshots BEGIN SELECT RAISE(ABORT,'rights scope snapshots are append-only'); END;
CREATE TRIGGER rights_configuration_audit_no_update BEFORE UPDATE ON rights_configuration_audit BEGIN SELECT RAISE(ABORT,'rights configuration audit is append-only'); END;
CREATE TRIGGER rights_configuration_audit_no_delete BEFORE DELETE ON rights_configuration_audit BEGIN SELECT RAISE(ABORT,'rights configuration audit is append-only'); END;

-- Current storefront projection. Runtime checkout uses the TypeScript resolver so arbitrary
-- evaluation timestamps can be honored; this view is the current-time discovery projection.
CREATE VIEW product_channel_availability AS
WITH effective_grants AS (
  SELECT rg.*, 'retail' AS effective_sales_channel FROM rights_grants rg WHERE rg.sales_channel='retail'
  UNION ALL
  SELECT rg.*, 'subscription' AS effective_sales_channel FROM rights_grants rg WHERE rg.sales_channel='subscription' OR (rg.sales_channel='retail' AND rg.subscription_permitted=1)
  UNION ALL
  SELECT rg.*, 'library' AS effective_sales_channel FROM rights_grants rg WHERE rg.sales_channel='library' OR (rg.sales_channel='retail' AND rg.library_permitted=1)
), legally_scoped AS (
  SELECT p.id AS product_id,p.edition_id,p.format AS product_format,e.drm_status AS edition_drm,
    rg.*,rgt.territory_code AS effective_territory_code
  FROM products p
  JOIN editions e ON e.id=p.edition_id
  JOIN effective_grants rg ON rg.edition_id=e.id AND lower(rg.format)=lower(p.format)
  JOIN rights_grant_territories rgt ON rgt.grant_id=rg.id
  WHERE p.storefront_status='active'
    AND rg.status='active'
    AND (rg.starts_at IS NULL OR rg.starts_at<=datetime('now'))
    AND (rg.ends_at IS NULL OR rg.ends_at>datetime('now'))
    AND (
      rg.contract_id IS NULL OR EXISTS(
        SELECT 1 FROM rights_contracts rc
        WHERE rc.id=rg.contract_id AND rc.status='active'
          AND (rc.effective_from IS NULL OR rc.effective_from<=datetime('now'))
          AND (rc.effective_to IS NULL OR rc.effective_to>datetime('now'))
          AND NOT EXISTS(
            SELECT 1 FROM rights_contract_languages deny
            JOIN edition_languages el ON el.edition_id=e.id AND el.kind='content' AND lower(el.language_code)=lower(deny.language_code)
            WHERE deny.contract_id=rc.id AND deny.decision='deny'
              AND (deny.format IS NULL OR lower(deny.format)=lower(p.format))
              AND (deny.sales_channel IS NULL OR deny.sales_channel=rg.effective_sales_channel)
              AND (deny.starts_at IS NULL OR deny.starts_at<=datetime('now')) AND (deny.ends_at IS NULL OR deny.ends_at>datetime('now'))
          )
          AND (
            NOT EXISTS(
              SELECT 1 FROM rights_contract_languages allow
              WHERE allow.contract_id=rc.id AND allow.decision='allow'
                AND (allow.format IS NULL OR lower(allow.format)=lower(p.format))
                AND (allow.sales_channel IS NULL OR allow.sales_channel=rg.effective_sales_channel)
                AND (allow.starts_at IS NULL OR allow.starts_at<=datetime('now')) AND (allow.ends_at IS NULL OR allow.ends_at>datetime('now'))
            )
            OR (rc.language_match_mode='any' AND EXISTS(
              SELECT 1 FROM rights_contract_languages allow
              JOIN edition_languages el ON el.edition_id=e.id AND el.kind='content' AND lower(el.language_code)=lower(allow.language_code)
              WHERE allow.contract_id=rc.id AND allow.decision='allow'
                AND (allow.format IS NULL OR lower(allow.format)=lower(p.format))
                AND (allow.sales_channel IS NULL OR allow.sales_channel=rg.effective_sales_channel)
                AND (allow.starts_at IS NULL OR allow.starts_at<=datetime('now')) AND (allow.ends_at IS NULL OR allow.ends_at>datetime('now'))
            ))
            OR (rc.language_match_mode='all' AND EXISTS(SELECT 1 FROM edition_languages el WHERE el.edition_id=e.id AND el.kind='content')
              AND NOT EXISTS(
                SELECT 1 FROM edition_languages el
                WHERE el.edition_id=e.id AND el.kind='content' AND NOT EXISTS(
                  SELECT 1 FROM rights_contract_languages allow
                  WHERE allow.contract_id=rc.id AND allow.decision='allow' AND lower(allow.language_code)=lower(el.language_code)
                    AND (allow.format IS NULL OR lower(allow.format)=lower(p.format))
                    AND (allow.sales_channel IS NULL OR allow.sales_channel=rg.effective_sales_channel)
                    AND (allow.starts_at IS NULL OR allow.starts_at<=datetime('now')) AND (allow.ends_at IS NULL OR allow.ends_at>datetime('now'))
                )
              )
            )
          )
      )
    )
)
SELECT DISTINCT
  allow.product_id,allow.edition_id,upper(allow.effective_territory_code) AS territory_code,
  allow.product_format AS format,allow.effective_sales_channel AS sales_channel,allow.id AS rights_grant_id
FROM legally_scoped allow
WHERE allow.decision='allow'
  AND NOT EXISTS(
    SELECT 1 FROM legally_scoped deny
    WHERE deny.product_id=allow.product_id
      AND upper(deny.effective_territory_code)=upper(allow.effective_territory_code)
      AND deny.effective_sales_channel=allow.effective_sales_channel
      AND deny.decision='deny'
  )
  AND (
    lower(COALESCE(allow.drm_requirement,'none')) IN ('','none','optional','any')
    OR (lower(allow.drm_requirement) IN ('none-only','drm-free') AND lower(COALESCE((SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=allow.edition_id AND ((allow.product_format='ebook' AND da.kind='epub') OR (allow.product_format='audiobook' AND da.kind='audio')) ORDER BY da.updated_at DESC LIMIT 1),allow.edition_drm,'none')) IN ('','none','drm-free'))
    OR (lower(allow.drm_requirement) IN ('required','drm','encrypted','any-drm') AND lower(COALESCE((SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=allow.edition_id AND ((allow.product_format='ebook' AND da.kind='epub') OR (allow.product_format='audiobook' AND da.kind='audio')) ORDER BY da.updated_at DESC LIMIT 1),allow.edition_drm,'none')) NOT IN ('','none','drm-free'))
    OR (lower(allow.drm_requirement) IN ('watermark','social-drm') AND lower(COALESCE((SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=allow.edition_id AND ((allow.product_format='ebook' AND da.kind='epub') OR (allow.product_format='audiobook' AND da.kind='audio')) ORDER BY da.updated_at DESC LIMIT 1),allow.edition_drm,'none')) IN ('watermark','social-drm'))
    OR (lower(allow.drm_requirement) IN ('adobe','adobe-acs','acs4') AND lower(COALESCE((SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=allow.edition_id AND ((allow.product_format='ebook' AND da.kind='epub') OR (allow.product_format='audiobook' AND da.kind='audio')) ORDER BY da.updated_at DESC LIMIT 1),allow.edition_drm,'none')) IN ('adobe','adobe-acs','acs4'))
    OR (lower(allow.drm_requirement) IN ('lcp','readium-lcp') AND lower(COALESCE((SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=allow.edition_id AND ((allow.product_format='ebook' AND da.kind='epub') OR (allow.product_format='audiobook' AND da.kind='audio')) ORDER BY da.updated_at DESC LIMIT 1),allow.edition_drm,'none')) IN ('lcp','readium-lcp'))
    OR lower(allow.drm_requirement)=lower(COALESCE((SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=allow.edition_id AND ((allow.product_format='ebook' AND da.kind='epub') OR (allow.product_format='audiobook' AND da.kind='audio')) ORDER BY da.updated_at DESC LIMIT 1),allow.edition_drm,'none'))
  );
CREATE VIEW retail_product_availability AS
SELECT product_id,edition_id,territory_code,format,rights_grant_id FROM product_channel_availability WHERE sales_channel='retail';

-- Commercial storefront browsing, taxonomy, landing pages, and merchandising CMS.
-- Raw supplier subjects remain in categories; this layer is Cove's curated retail taxonomy.

ALTER TABLE catalog_search_documents ADD COLUMN publication_date text;
ALTER TABLE catalog_search_documents ADD COLUMN preorder_date text;
ALTER TABLE catalog_search_documents ADD COLUMN product_created_at text;
ALTER TABLE catalog_search_documents ADD COLUMN product_updated_at text;
ALTER TABLE catalog_search_documents ADD COLUMN taxonomy_text text DEFAULT '' NOT NULL;

CREATE INDEX idx_search_publication_date ON catalog_search_documents(publication_date);
CREATE INDEX idx_search_preorder_date ON catalog_search_documents(preorder_date);
CREATE INDEX idx_search_product_created ON catalog_search_documents(product_created_at);
CREATE INDEX idx_search_product_updated ON catalog_search_documents(product_updated_at);

CREATE TABLE storefront_taxonomies (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  version text NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  is_default integer DEFAULT 0 NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX idx_storefront_taxonomy_default ON storefront_taxonomies(is_default) WHERE is_default=1;

CREATE TABLE storefront_taxonomy_nodes (
  id text PRIMARY KEY NOT NULL,
  taxonomy_id text NOT NULL REFERENCES storefront_taxonomies(id) ON DELETE CASCADE,
  parent_id text REFERENCES storefront_taxonomy_nodes(id) ON DELETE CASCADE,
  slug text NOT NULL,
  path text NOT NULL,
  name text NOT NULL,
  description text DEFAULT '' NOT NULL,
  depth integer DEFAULT 0 NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  visible integer DEFAULT 1 NOT NULL,
  featured integer DEFAULT 0 NOT NULL,
  seo_title text DEFAULT '' NOT NULL,
  seo_description text DEFAULT '' NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX idx_storefront_taxonomy_path ON storefront_taxonomy_nodes(taxonomy_id,path);
CREATE INDEX idx_storefront_taxonomy_parent ON storefront_taxonomy_nodes(taxonomy_id,parent_id,sort_order);
CREATE INDEX idx_storefront_taxonomy_visible ON storefront_taxonomy_nodes(taxonomy_id,visible,featured,sort_order);

CREATE TABLE storefront_taxonomy_mappings (
  id text PRIMARY KEY NOT NULL,
  taxonomy_node_id text NOT NULL REFERENCES storefront_taxonomy_nodes(id) ON DELETE CASCADE,
  source_scheme text NOT NULL,
  source_value text NOT NULL,
  match_mode text DEFAULT 'contains' NOT NULL,
  priority integer DEFAULT 0 NOT NULL,
  active integer DEFAULT 1 NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX idx_storefront_taxonomy_mapping_source ON storefront_taxonomy_mappings(source_scheme,active,priority);

CREATE TABLE edition_taxonomy_nodes (
  edition_id text NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  taxonomy_node_id text NOT NULL REFERENCES storefront_taxonomy_nodes(id) ON DELETE CASCADE,
  source text DEFAULT 'mapping' NOT NULL,
  confidence real DEFAULT 1 NOT NULL,
  is_primary integer DEFAULT 0 NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY(edition_id,taxonomy_node_id)
);
CREATE INDEX idx_edition_taxonomy_node ON edition_taxonomy_nodes(taxonomy_node_id,edition_id);

CREATE TABLE storefront_pages (
  id text PRIMARY KEY NOT NULL,
  path text NOT NULL,
  page_type text DEFAULT 'browse' NOT NULL,
  title text NOT NULL,
  heading text NOT NULL,
  description text DEFAULT '' NOT NULL,
  eyebrow text DEFAULT '' NOT NULL,
  seo_title text DEFAULT '' NOT NULL,
  seo_description text DEFAULT '' NOT NULL,
  taxonomy_node_id text REFERENCES storefront_taxonomy_nodes(id) ON DELETE SET NULL,
  collection_id text,
  query_json text DEFAULT '{}' NOT NULL,
  status text DEFAULT 'published' NOT NULL,
  territory_code text,
  language_code text,
  starts_at text,
  ends_at text,
  noindex integer DEFAULT 0 NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX idx_storefront_pages_path ON storefront_pages(path);
CREATE INDEX idx_storefront_pages_publish ON storefront_pages(status,territory_code,language_code,starts_at,ends_at);

CREATE TABLE merch_campaigns (
  id text PRIMARY KEY NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  status text DEFAULT 'draft' NOT NULL,
  campaign_type text DEFAULT 'editorial' NOT NULL,
  priority integer DEFAULT 0 NOT NULL,
  territory_code text,
  language_code text,
  audience_json text DEFAULT '{}' NOT NULL,
  starts_at text,
  ends_at text,
  created_by text DEFAULT 'operator' NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX idx_merch_campaign_slug ON merch_campaigns(slug);
CREATE INDEX idx_merch_campaign_live ON merch_campaigns(status,territory_code,language_code,starts_at,ends_at,priority);

CREATE TABLE merch_slots (
  id text PRIMARY KEY NOT NULL,
  slot_key text NOT NULL,
  name text NOT NULL,
  placement_type text DEFAULT 'rail' NOT NULL,
  max_items integer DEFAULT 12 NOT NULL,
  description text DEFAULT '' NOT NULL,
  active integer DEFAULT 1 NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX idx_merch_slot_key ON merch_slots(slot_key);

CREATE TABLE merch_collections (
  id text PRIMARY KEY NOT NULL,
  slug text NOT NULL,
  title text NOT NULL,
  description text DEFAULT '' NOT NULL,
  curator text DEFAULT 'Cove editors' NOT NULL,
  mode text DEFAULT 'manual' NOT NULL,
  query_json text DEFAULT '{}' NOT NULL,
  status text DEFAULT 'draft' NOT NULL,
  territory_code text,
  language_code text,
  starts_at text,
  ends_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX idx_merch_collection_slug ON merch_collections(slug);
CREATE INDEX idx_merch_collection_live ON merch_collections(status,territory_code,language_code,starts_at,ends_at);

CREATE TABLE merch_collection_items (
  collection_id text NOT NULL REFERENCES merch_collections(id) ON DELETE CASCADE,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sort_order integer DEFAULT 0 NOT NULL,
  badge text DEFAULT '' NOT NULL,
  title_override text DEFAULT '' NOT NULL,
  subtitle_override text DEFAULT '' NOT NULL,
  starts_at text,
  ends_at text,
  PRIMARY KEY(collection_id,product_id)
);
CREATE INDEX idx_merch_collection_items_order ON merch_collection_items(collection_id,sort_order);

CREATE TABLE merch_experiments (
  id text PRIMARY KEY NOT NULL,
  experiment_key text NOT NULL,
  name text NOT NULL,
  status text DEFAULT 'draft' NOT NULL,
  variants_json text DEFAULT '[{"key":"control","weight":100}]' NOT NULL,
  starts_at text,
  ends_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX idx_merch_experiment_key ON merch_experiments(experiment_key);
CREATE INDEX idx_merch_experiment_live ON merch_experiments(status,starts_at,ends_at);

CREATE TABLE merch_placements (
  id text PRIMARY KEY NOT NULL,
  campaign_id text NOT NULL REFERENCES merch_campaigns(id) ON DELETE CASCADE,
  slot_id text NOT NULL REFERENCES merch_slots(id) ON DELETE CASCADE,
  source_type text DEFAULT 'collection' NOT NULL,
  product_id text REFERENCES products(id) ON DELETE CASCADE,
  collection_id text REFERENCES merch_collections(id) ON DELETE CASCADE,
  query_json text DEFAULT '{}' NOT NULL,
  title text DEFAULT '' NOT NULL,
  eyebrow text DEFAULT '' NOT NULL,
  body text DEFAULT '' NOT NULL,
  cta_label text DEFAULT '' NOT NULL,
  cta_href text DEFAULT '' NOT NULL,
  image_url text DEFAULT '' NOT NULL,
  badge text DEFAULT '' NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  weight integer DEFAULT 100 NOT NULL,
  sponsored integer DEFAULT 0 NOT NULL,
  sponsor_name text DEFAULT '' NOT NULL,
  territory_code text,
  language_code text,
  experiment_id text REFERENCES merch_experiments(id) ON DELETE SET NULL,
  experiment_variant text,
  starts_at text,
  ends_at text,
  active integer DEFAULT 1 NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX idx_merch_placements_slot ON merch_placements(slot_id,active,sort_order);
CREATE INDEX idx_merch_placements_schedule ON merch_placements(active,territory_code,language_code,starts_at,ends_at);
CREATE INDEX idx_merch_placements_campaign ON merch_placements(campaign_id);

CREATE TABLE merch_events (
  id text PRIMARY KEY NOT NULL,
  event_type text NOT NULL,
  placement_id text NOT NULL REFERENCES merch_placements(id) ON DELETE CASCADE,
  campaign_id text NOT NULL REFERENCES merch_campaigns(id) ON DELETE CASCADE,
  slot_key text NOT NULL,
  visitor_id text NOT NULL,
  user_id text,
  product_id text REFERENCES products(id) ON DELETE SET NULL,
  experiment_id text,
  experiment_variant text,
  position integer,
  created_at text NOT NULL
);
CREATE INDEX idx_merch_events_campaign ON merch_events(campaign_id,event_type,created_at);
CREATE INDEX idx_merch_events_placement ON merch_events(placement_id,event_type,created_at);
CREATE INDEX idx_merch_events_visitor ON merch_events(visitor_id,created_at);

-- Seed the initial retail taxonomy. The mapping layer is intentionally independent of
-- Gutenberg so future ONIX/BISAC/THEMA feeds can map into the same storefront tree.
INSERT INTO storefront_taxonomies(id,name,version,status,is_default,created_at,updated_at)
VALUES('tax_fore_books','Cove Books','2026.1','active',1,datetime('now'),datetime('now'));

INSERT INTO storefront_taxonomy_nodes(id,taxonomy_id,parent_id,slug,path,name,description,depth,sort_order,featured,created_at,updated_at) VALUES
('tax_fiction','tax_fore_books',NULL,'fiction','fiction','Fiction & Literature','Novels, stories, classics, and literary fiction.',0,10,1,datetime('now'),datetime('now')),
('tax_fiction_classics','tax_fore_books','tax_fiction','classics','fiction/classics','Classics','Enduring fiction across periods and traditions.',1,10,1,datetime('now'),datetime('now')),
('tax_fiction_literary','tax_fore_books','tax_fiction','literary-fiction','fiction/literary-fiction','Literary Fiction','Character-driven and stylistically ambitious fiction.',1,20,0,datetime('now'),datetime('now')),
('tax_fiction_adventure','tax_fore_books','tax_fiction','adventure','fiction/adventure','Adventure','Journeys, exploration, survival, and high-stakes quests.',1,30,1,datetime('now'),datetime('now')),
('tax_fiction_mystery','tax_fore_books','tax_fiction','mystery-thriller','fiction/mystery-thriller','Mystery & Thriller','Mysteries, thrillers, detective fiction, and suspense.',1,40,1,datetime('now'),datetime('now')),
('tax_fiction_detective','tax_fore_books','tax_fiction_mystery','detective','fiction/mystery-thriller/detective','Detective Fiction','Investigators, clues, and classic detection.',2,10,0,datetime('now'),datetime('now')),
('tax_fiction_crime','tax_fore_books','tax_fiction_mystery','crime','fiction/mystery-thriller/crime','Crime','Crime stories, criminals, and investigations.',2,20,0,datetime('now'),datetime('now')),
('tax_fiction_suspense','tax_fore_books','tax_fiction_mystery','suspense','fiction/mystery-thriller/suspense','Suspense','Tense fiction driven by danger and uncertainty.',2,30,0,datetime('now'),datetime('now')),
('tax_fiction_romance','tax_fore_books','tax_fiction','romance','fiction/romance','Romance','Love stories across eras and settings.',1,50,1,datetime('now'),datetime('now')),
('tax_fiction_gothic','tax_fore_books','tax_fiction_romance','gothic-romance','fiction/romance/gothic-romance','Gothic Romance','Romance with gothic atmosphere and suspense.',2,10,0,datetime('now'),datetime('now')),
('tax_fiction_fantasy','tax_fore_books','tax_fiction','fantasy','fiction/fantasy','Fantasy','Magic, mythic worlds, and the fantastic.',1,60,1,datetime('now'),datetime('now')),
('tax_fiction_folklore','tax_fore_books','tax_fiction_fantasy','fairy-tales-folklore','fiction/fantasy/fairy-tales-folklore','Fairy Tales & Folklore','Folk stories, legends, fairy tales, and mythology.',2,10,0,datetime('now'),datetime('now')),
('tax_fiction_scifi','tax_fore_books','tax_fiction','science-fiction','fiction/science-fiction','Science Fiction','Speculative futures, science, technology, and other worlds.',1,70,1,datetime('now'),datetime('now')),
('tax_fiction_horror','tax_fore_books','tax_fiction','horror','fiction/horror','Horror','Gothic, supernatural, and psychological horror.',1,80,0,datetime('now'),datetime('now')),
('tax_fiction_historical','tax_fore_books','tax_fiction','historical-fiction','fiction/historical-fiction','Historical Fiction','Fiction grounded in historical eras and events.',1,90,0,datetime('now'),datetime('now')),
('tax_fiction_short','tax_fore_books','tax_fiction','short-stories','fiction/short-stories','Short Stories','Short-form fiction and story collections.',1,100,0,datetime('now'),datetime('now')),
('tax_fiction_humor','tax_fore_books','tax_fiction','humor-satire','fiction/humor-satire','Humor & Satire','Comic fiction, parody, and satire.',1,110,0,datetime('now'),datetime('now')),
('tax_ya','tax_fore_books',NULL,'young-adult','young-adult','Young Adult','Stories and literature for teen readers.',0,20,1,datetime('now'),datetime('now')),
('tax_ya_fiction','tax_fore_books','tax_ya','fiction','young-adult/fiction','YA Fiction','Young adult fiction across genres.',1,10,0,datetime('now'),datetime('now')),
('tax_ya_fantasy','tax_fore_books','tax_ya','fantasy','young-adult/fantasy','YA Fantasy','Fantasy for young adult readers.',1,20,0,datetime('now'),datetime('now')),
('tax_children','tax_fore_books',NULL,'children','children','Children''s Books','Stories, classics, and learning for younger readers.',0,30,1,datetime('now'),datetime('now')),
('tax_children_fiction','tax_fore_books','tax_children','fiction','children/fiction','Children''s Fiction','Fiction for children and middle-grade readers.',1,10,0,datetime('now'),datetime('now')),
('tax_children_classics','tax_fore_books','tax_children','classics','children/classics','Children''s Classics','Classic books for younger readers.',1,20,0,datetime('now'),datetime('now')),
('tax_children_fairy','tax_fore_books','tax_children','fairy-tales','children/fairy-tales','Fairy Tales','Traditional fairy tales and folk stories for children.',1,30,0,datetime('now'),datetime('now')),
('tax_nonfiction','tax_fore_books',NULL,'nonfiction','nonfiction','Nonfiction','History, ideas, lives, science, society, and practical knowledge.',0,40,1,datetime('now'),datetime('now')),
('tax_biography','tax_fore_books','tax_nonfiction','biography-memoir','nonfiction/biography-memoir','Biography & Memoir','Lives, autobiographies, memoirs, letters, and diaries.',1,10,1,datetime('now'),datetime('now')),
('tax_history','tax_fore_books','tax_nonfiction','history','nonfiction/history','History','World history, eras, nations, wars, and historical study.',1,20,1,datetime('now'),datetime('now')),
('tax_history_ancient','tax_fore_books','tax_history','ancient','nonfiction/history/ancient','Ancient History','Ancient civilizations and classical history.',2,10,0,datetime('now'),datetime('now')),
('tax_history_military','tax_fore_books','tax_history','military','nonfiction/history/military','Military History','Wars, campaigns, armies, and military history.',2,20,0,datetime('now'),datetime('now')),
('tax_philosophy','tax_fore_books','tax_nonfiction','philosophy','nonfiction/philosophy','Philosophy','Philosophical works, ethics, logic, and political thought.',1,30,1,datetime('now'),datetime('now')),
('tax_religion','tax_fore_books','tax_nonfiction','religion-spirituality','nonfiction/religion-spirituality','Religion & Spirituality','Religion, theology, scripture, and spiritual writing.',1,40,0,datetime('now'),datetime('now')),
('tax_science','tax_fore_books','tax_nonfiction','science-nature','nonfiction/science-nature','Science & Nature','Science, mathematics, medicine, technology, and nature.',1,50,1,datetime('now'),datetime('now')),
('tax_business','tax_fore_books','tax_nonfiction','business-economics','nonfiction/business-economics','Business & Economics','Economics, commerce, finance, and management.',1,60,0,datetime('now'),datetime('now')),
('tax_selfhelp','tax_fore_books','tax_nonfiction','self-help','nonfiction/self-help','Self-Help & Personal Growth','Practical guidance, habits, and personal development.',1,70,0,datetime('now'),datetime('now')),
('tax_politics','tax_fore_books','tax_nonfiction','politics-society','nonfiction/politics-society','Politics & Society','Politics, government, law, sociology, and social thought.',1,80,0,datetime('now'),datetime('now')),
('tax_travel','tax_fore_books','tax_nonfiction','travel','nonfiction/travel','Travel','Travel writing, places, exploration, and geography.',1,90,0,datetime('now'),datetime('now')),
('tax_education','tax_fore_books','tax_nonfiction','education','nonfiction/education','Education','Teaching, study, pedagogy, and educational works.',1,100,0,datetime('now'),datetime('now')),
('tax_reference','tax_fore_books','tax_nonfiction','reference','nonfiction/reference','Reference','Dictionaries, encyclopedic works, manuals, and reference texts.',1,110,0,datetime('now'),datetime('now')),
('tax_poetry','tax_fore_books',NULL,'poetry','poetry','Poetry','Poetry, verse, and poetic collections.',0,50,1,datetime('now'),datetime('now')),
('tax_drama','tax_fore_books',NULL,'drama','drama','Drama & Plays','Drama, plays, and works written for the stage.',0,60,1,datetime('now'),datetime('now')),
('tax_essays','tax_fore_books',NULL,'essays','essays','Essays','Essays, criticism, and collected prose.',0,70,0,datetime('now'),datetime('now')),
('tax_comics','tax_fore_books',NULL,'comics-graphic-novels','comics-graphic-novels','Comics & Graphic Novels','Sequential art, comics, and graphic storytelling.',0,80,0,datetime('now'),datetime('now'));

-- Keyword mappings from heterogeneous supplier taxonomies into the retail tree.
INSERT INTO storefront_taxonomy_mappings(id,taxonomy_node_id,source_scheme,source_value,match_mode,priority,created_at,updated_at) VALUES
('map_fiction','tax_fiction','*','fiction','contains',10,datetime('now'),datetime('now')),
('map_classics','tax_fiction_classics','*','classic','contains',20,datetime('now'),datetime('now')),
('map_adventure','tax_fiction_adventure','*','adventure','contains',40,datetime('now'),datetime('now')),
('map_mystery','tax_fiction_mystery','*','mystery','contains',40,datetime('now'),datetime('now')),
('map_detective','tax_fiction_detective','*','detective','contains',60,datetime('now'),datetime('now')),
('map_crime','tax_fiction_crime','*','crime','contains',50,datetime('now'),datetime('now')),
('map_suspense','tax_fiction_suspense','*','suspense','contains',50,datetime('now'),datetime('now')),
('map_romance','tax_fiction_romance','*','romance','contains',50,datetime('now'),datetime('now')),
('map_gothic','tax_fiction_gothic','*','gothic','contains',55,datetime('now'),datetime('now')),
('map_fantasy','tax_fiction_fantasy','*','fantasy','contains',50,datetime('now'),datetime('now')),
('map_fairy','tax_fiction_folklore','*','fairy','contains',60,datetime('now'),datetime('now')),
('map_folklore','tax_fiction_folklore','*','folklore','contains',60,datetime('now'),datetime('now')),
('map_mythology','tax_fiction_folklore','*','mytholog','contains',60,datetime('now'),datetime('now')),
('map_scifi','tax_fiction_scifi','*','science fiction','contains',70,datetime('now'),datetime('now')),
('map_horror','tax_fiction_horror','*','horror','contains',60,datetime('now'),datetime('now')),
('map_historicalfiction','tax_fiction_historical','*','historical fiction','contains',70,datetime('now'),datetime('now')),
('map_short','tax_fiction_short','*','short stor','contains',60,datetime('now'),datetime('now')),
('map_humor','tax_fiction_humor','*','humor','contains',50,datetime('now'),datetime('now')),
('map_satire','tax_fiction_humor','*','satire','contains',50,datetime('now'),datetime('now')),
('map_ya','tax_ya','*','young adult','contains',80,datetime('now'),datetime('now')),
('map_juvenile','tax_children','*','juvenile','contains',70,datetime('now'),datetime('now')),
('map_children','tax_children','*','children','contains',70,datetime('now'),datetime('now')),
('map_biography','tax_biography','*','biograph','contains',60,datetime('now'),datetime('now')),
('map_autobiography','tax_biography','*','autobiograph','contains',70,datetime('now'),datetime('now')),
('map_memoir','tax_biography','*','memoir','contains',70,datetime('now'),datetime('now')),
('map_history','tax_history','*','history','contains',40,datetime('now'),datetime('now')),
('map_ancient','tax_history_ancient','*','ancient','contains',60,datetime('now'),datetime('now')),
('map_military','tax_history_military','*','military','contains',60,datetime('now'),datetime('now')),
('map_philosophy','tax_philosophy','*','philosoph','contains',60,datetime('now'),datetime('now')),
('map_religion','tax_religion','*','religion','contains',50,datetime('now'),datetime('now')),
('map_theology','tax_religion','*','theolog','contains',60,datetime('now'),datetime('now')),
('map_science','tax_science','*','science','contains',40,datetime('now'),datetime('now')),
('map_nature','tax_science','*','natural history','contains',50,datetime('now'),datetime('now')),
('map_math','tax_science','*','mathemat','contains',60,datetime('now'),datetime('now')),
('map_economics','tax_business','*','economic','contains',60,datetime('now'),datetime('now')),
('map_business','tax_business','*','business','contains',60,datetime('now'),datetime('now')),
('map_selfhelp','tax_selfhelp','*','self-help','contains',70,datetime('now'),datetime('now')),
('map_politics','tax_politics','*','politic','contains',50,datetime('now'),datetime('now')),
('map_law','tax_politics','*','law','contains',50,datetime('now'),datetime('now')),
('map_sociology','tax_politics','*','sociolog','contains',60,datetime('now'),datetime('now')),
('map_travel','tax_travel','*','travel','contains',60,datetime('now'),datetime('now')),
('map_education','tax_education','*','education','contains',60,datetime('now'),datetime('now')),
('map_reference','tax_reference','*','reference','contains',50,datetime('now'),datetime('now')),
('map_dictionary','tax_reference','*','dictionar','contains',60,datetime('now'),datetime('now')),
('map_poetry','tax_poetry','*','poetry','contains',80,datetime('now'),datetime('now')),
('map_drama','tax_drama','*','drama','contains',70,datetime('now'),datetime('now')),
('map_play','tax_drama','*','plays','contains',60,datetime('now'),datetime('now')),
('map_essay','tax_essays','*','essay','contains',70,datetime('now'),datetime('now')),
('map_comics','tax_comics','*','comic','contains',70,datetime('now'),datetime('now'));

-- Backfill taxonomy assignments for editions already normalized before this migration.
INSERT OR IGNORE INTO edition_taxonomy_nodes(edition_id,taxonomy_node_id,source,confidence,is_primary,created_at)
SELECT DISTINCT ec.edition_id,m.taxonomy_node_id,'mapping',CASE WHEN m.match_mode='exact' THEN 1.0 ELSE 0.85 END,0,datetime('now')
FROM edition_categories ec
JOIN categories c ON c.id=ec.category_id
JOIN storefront_taxonomy_mappings m ON m.active=1
  AND (m.source_scheme='*' OR m.source_scheme=c.scheme)
  AND ((m.match_mode='exact' AND lower(c.name)=lower(m.source_value))
       OR (m.match_mode='prefix' AND lower(c.name) LIKE lower(m.source_value)||'%')
       OR (m.match_mode='contains' AND lower(c.name) LIKE '%'||lower(m.source_value)||'%'));

-- Keep ancestor nodes available for browse counts/filtering by materializing ancestor assignments.
INSERT OR IGNORE INTO edition_taxonomy_nodes(edition_id,taxonomy_node_id,source,confidence,is_primary,created_at)
SELECT et.edition_id,n.parent_id,'ancestor',et.confidence,0,datetime('now')
FROM edition_taxonomy_nodes et JOIN storefront_taxonomy_nodes n ON n.id=et.taxonomy_node_id WHERE n.parent_id IS NOT NULL;
INSERT OR IGNORE INTO edition_taxonomy_nodes(edition_id,taxonomy_node_id,source,confidence,is_primary,created_at)
SELECT et.edition_id,n.parent_id,'ancestor',et.confidence,0,datetime('now')
FROM edition_taxonomy_nodes et JOIN storefront_taxonomy_nodes n ON n.id=et.taxonomy_node_id WHERE n.parent_id IS NOT NULL;

-- Core browse landing pages. Taxonomy pages are resolved dynamically from /ebooks/<path>.
INSERT INTO storefront_pages(id,path,page_type,title,heading,description,eyebrow,seo_title,seo_description,query_json,status,created_at,updated_at) VALUES
('page_bestsellers','/bestsellers','browse','Bestsellers','Books readers are choosing now','Popular titles ranked by Cove activity and catalog demand.','BESTSELLERS','Bestselling eBooks | Cove','Discover bestselling eBooks on Cove.','{"sort":"popular"}','published',datetime('now'),datetime('now')),
('page_new_releases','/new-releases','browse','New releases','New releases','Recently released editions available to read on Cove.','NEW & NOTEWORTHY','New eBook Releases | Cove','Discover newly released eBooks on Cove.','{"newRelease":true,"sort":"released"}','published',datetime('now'),datetime('now')),
('page_preorders','/preorders','browse','Coming soon','Coming soon','Upcoming editions available for preorder or advance discovery.','COMING SOON','Upcoming eBooks & Preorders | Cove','Browse upcoming eBooks and preorders on Cove.','{"preorder":true,"sort":"coming_soon"}','published',datetime('now'),datetime('now')),
('page_deals','/deals','browse','Deals','Deals worth opening','Current price promotions and featured free editions.','LIMITED-TIME OFFERS','eBook Deals | Cove','Browse current eBook deals on Cove.','{"deals":true,"sort":"popular"}','published',datetime('now'),datetime('now'));

-- Merchandising slots are stable contracts between the CMS and storefront UI.
INSERT INTO merch_slots(id,slot_key,name,placement_type,max_items,description,active,created_at,updated_at) VALUES
('slot_home_hero','home.hero','Homepage hero','hero',1,'Primary editorial hero on the bookstore home page.',1,datetime('now'),datetime('now')),
('slot_home_primary','home.primary','Homepage primary rail','rail',12,'Top editorial collection beneath the hero.',1,datetime('now'),datetime('now')),
('slot_home_secondary','home.secondary','Homepage secondary rail','rail',12,'Secondary editorial collection.',1,datetime('now'),datetime('now')),
('slot_home_campaign','home.campaign','Homepage campaign banner','banner',1,'Seasonal or regional campaign banner.',1,datetime('now'),datetime('now'));

INSERT INTO merch_campaigns(id,slug,name,status,campaign_type,priority,audience_json,created_at,updated_at)
VALUES('campaign_fore_default','fore-default','Cove default storefront','published','editorial',0,'{}',datetime('now'),datetime('now'));

-- These defaults are query-driven rather than hard-coded to a Gutenberg ID. Staff can replace
-- them in the CMS without a deploy.
INSERT INTO merch_placements(id,campaign_id,slot_id,source_type,query_json,title,eyebrow,body,cta_label,cta_href,sort_order,weight,active,created_at,updated_at) VALUES
('placement_home_hero_default','campaign_fore_default','slot_home_hero','query','{"sort":"popular","limit":1}','The Cove Edit','THE FORE EDIT','A hand-picked starting point from the books readers return to.','Explore the book','',0,100,1,datetime('now'),datetime('now')),
('placement_home_primary_default','campaign_fore_default','slot_home_primary','query','{"sort":"popular","limit":12}','Popular right now','READERS ARE OPENING','A living shelf shaped by reading activity and catalog demand.','See all','/bestsellers',0,100,1,datetime('now'),datetime('now')),
('placement_home_secondary_default','campaign_fore_default','slot_home_secondary','query','{"sort":"added","limit":12}','Fresh to Cove','RECENTLY ADDED','Recently ingested editions, independent of their original publication date.','Browse recent additions','/store?sort=added',0,100,1,datetime('now'),datetime('now'));

-- Populate the newly added search projection dates for existing products.
UPDATE catalog_search_documents
SET publication_date=(SELECT e.publication_date FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=catalog_search_documents.product_id),
    release_date=(SELECT e.release_date FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=catalog_search_documents.product_id),
    preorder_date=(SELECT e.preorder_date FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=catalog_search_documents.product_id),
    product_created_at=(SELECT p.created_at FROM products p WHERE p.id=catalog_search_documents.product_id),
    product_updated_at=(SELECT p.updated_at FROM products p WHERE p.id=catalog_search_documents.product_id),
    taxonomy_text=COALESCE((SELECT group_concat(n.path,' | ') FROM products p JOIN editions e ON e.id=p.edition_id JOIN edition_taxonomy_nodes et ON et.edition_id=e.id JOIN storefront_taxonomy_nodes n ON n.id=et.taxonomy_node_id WHERE p.id=catalog_search_documents.product_id),'');

CREATE TABLE storefront_admin_audit (
  id text PRIMARY KEY NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  before_json text,
  after_json text,
  created_at text NOT NULL
);
CREATE INDEX idx_storefront_admin_audit_entity ON storefront_admin_audit(entity_type,entity_id,created_at);
CREATE INDEX idx_storefront_admin_audit_recent ON storefront_admin_audit(created_at);

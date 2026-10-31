/* eslint-disable prettier/prettier -- Execute the actual unexported private publishing helpers against all migrated tables. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,readdirSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadPrivateFinance} from "./test-private-finance-loader.mjs";
const folder=mkdtempSync(join(tmpdir(),"cove-pub-helper-")),stores=[];
try{
 const {testPublishingHelpers:helper}=await loadPrivateFinance(join(folder,"owner.mjs"));
 const migrations=readdirSync("drizzle").filter(x=>x.endsWith(".sql")).sort().map(x=>readFileSync("drizzle/"+x,"utf8"));
 function fixture(){
  const sql=new DatabaseSync(":memory:");stores.push(sql);for(const m of migrations)sql.exec(m);sql.exec("PRAGMA foreign_keys=ON");
  const at="2026-01-01T00:00:00Z",accountId="pubacct_helper_qa",editionId="pubedition_helper_qa";
  sql.prepare("INSERT INTO publishing_accounts(id,account_type,legal_name,display_name,country_code,status,identity_status,tax_status,payout_status,created_at,updated_at) VALUES(?,'company','QA Legal','QA Publisher','US','active','verified','verified','verified',?,?)").run(accountId,at,at);
  sql.prepare("INSERT INTO publishing_titles(id,account_id,title,created_at,updated_at) VALUES('title_helper_qa',?,'QA title',?,?)").run(accountId,at,at);
  sql.prepare("INSERT INTO publishing_edition_drafts(id,title_id,status,created_at,updated_at) VALUES(?,'title_helper_qa','draft',?,?)").run(editionId,at,at);
  const baseline=Object.fromEntries(["publishers","rights_parties","finance_parties"].map(t=>[t,Number(sql.prepare("SELECT COUNT(*) n FROM "+t).get().n)]));
  let fail=-1,lost=false,beforeBatch=null;
  const db={prepare(query){const stmt=(params=[])=>({bind:(...p)=>stmt(p),async first(){return sql.prepare(query).get(...params)||null;},async all(){return {results:sql.prepare(query).all(...params)};},async run(){if(!query.startsWith("INSERT OR IGNORE INTO publishing_publication_activations"))throw Error("Publishing helper mutation outside atomic batch: "+query);const meta=sql.prepare(query).run(...params);if(lost){lost=false;throw Error("activation_lost_ack");}return {meta};},execute(){return {meta:sql.prepare(query).run(...params)};}});return stmt();},async batch(statements){if(beforeBatch){const f=beforeBatch;beforeBatch=null;f();}sql.exec("BEGIN");try{const out=[];for(let i=0;i<statements.length;i++){if(i===fail)throw Error("publication_batch_failure");out.push(statements[i].execute());}sql.exec("COMMIT");if(lost){lost=false;throw Error("publication_lost_commit_response");}return out;}catch(e){if(sql.isTransaction)sql.exec("ROLLBACK");throw e;}}};
  return {sql,db,baseline,at,accountId,editionId,inject(n){fail=n;},lose(){lost=true;},before(f){beforeBatch=f;},account(){return sql.prepare("SELECT * FROM publishing_accounts WHERE id=?").get(accountId);}};
 }
 for(const at of [0,1]){
  const f=fixture();f.inject(at);await assert.rejects(helper.ensurePublishingLifecycle(f.db,f.editionId));
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM publishing_release_lifecycles").get().n,0);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM publishing_lifecycle_events").get().n,0);
 }
 const f=fixture();f.lose();const lifecycle=await helper.ensurePublishingLifecycle(f.db,f.editionId);
 assert.equal((await helper.ensurePublishingLifecycle(f.db,f.editionId)).id,lifecycle.id);
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM publishing_lifecycle_events").get().n,1);
 for(const at of [0,1]){
  f.inject(at);await assert.rejects(helper.transitionPublishingLifecycle(f.db,f.editionId,"validation","automation",null,"CHECK"));
  assert.equal(f.sql.prepare("SELECT state FROM publishing_release_lifecycles").get().state,"draft");
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM publishing_lifecycle_events").get().n,1);
 }
 f.inject(-1);f.lose();await helper.transitionPublishingLifecycle(f.db,f.editionId,"validation","automation",null,"CHECK");
 await helper.transitionPublishingLifecycle(f.db,f.editionId,"validation","automation",null,"CHECK");assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM publishing_lifecycle_events").get().n,2);
 const raced=fixture();await helper.ensurePublishingLifecycle(raced.db,raced.editionId);
 raced.before(()=>raced.sql.prepare("UPDATE publishing_release_lifecycles SET state='suppressed',updated_at='newer' WHERE publishing_edition_id=?").run(raced.editionId));
 await assert.rejects(helper.transitionPublishingLifecycle(raced.db,raced.editionId,"validation","automation",null,"CHECK"),/changed before/);
 assert.equal(raced.sql.prepare("SELECT COUNT(*) n FROM publishing_lifecycle_events").get().n,1);
 await assert.rejects(helper.transitionPublishingLifecycle(raced.db,raced.editionId,"live","migration",null,"RESTORE"),/fresh independently verified/);
 for(const at of [0,1,2,3]){
  const party=fixture();party.inject(at);await assert.rejects(helper.ensureCatalogParties(party.db,party.account(),{country_code:"US"},{payout_currency:"USD"}));
  for(const table of ["publishers","rights_parties","finance_parties"])assert.equal(party.sql.prepare("SELECT COUNT(*) n FROM "+table).get().n,party.baseline[table]);
  assert.equal(party.account().publisher_id,null);
 }
 const party=fixture();
 party.sql.prepare("INSERT INTO publishing_accounts(id,account_type,legal_name,display_name,country_code,status,identity_status,tax_status,payout_status,created_at,updated_at) VALUES('other_pubacct','company','Other','Other','CA','active','verified','verified','verified',?,?)").run(party.at,party.at);
 party.lose();const result=await helper.ensureCatalogParties(party.db,party.account(),{country_code:"US"},{payout_currency:"USD"});
 assert.deepEqual(await helper.ensureCatalogParties(party.db,party.account(),{country_code:"US"},{payout_currency:"USD"}),result);
 for(const table of ["publishers","rights_parties","finance_parties"])assert.equal(party.sql.prepare("SELECT COUNT(*) n FROM "+table).get().n,party.baseline[table]+1);
 assert.equal(party.sql.prepare("SELECT publisher_id FROM publishing_accounts WHERE id='other_pubacct'").get().publisher_id,null,"Publisher parties cannot overwrite another account");
 const revoked=fixture();revoked.before(()=>revoked.sql.prepare("UPDATE publishing_accounts SET tax_status='expired' WHERE id=?").run(revoked.accountId));
 await assert.rejects(helper.ensureCatalogParties(revoked.db,revoked.account(),{country_code:"US"},{payout_currency:"USD"}),/compliance changed/);
 for(const table of ["publishers","rights_parties","finance_parties"])assert.equal(revoked.sql.prepare("SELECT COUNT(*) n FROM "+table).get().n,revoked.baseline[table]);

 const activation=fixture(),life=await helper.ensurePublishingLifecycle(activation.db,activation.editionId),at=activation.at;
 activation.sql.prepare("INSERT INTO works(id,title,created_at,updated_at) VALUES('work_activation','QA',?,?)").run(at,at);
 activation.sql.prepare("INSERT INTO editions(id,work_id,title,created_at,updated_at) VALUES('ed_activation','work_activation','QA',?,?)").run(at,at);
 activation.sql.prepare("INSERT INTO products(id,edition_id,sku,format,source_name,source_external_id,created_at,updated_at) VALUES('prd_activation','ed_activation','sku_activation','ebook','publishing','pub_activation',?,?)").run(at,at);
 activation.sql.prepare("INSERT INTO publishing_submission_snapshots(id,edition_id,account_id,revision,snapshot_json,snapshot_sha256,status,submitted_by_user_id,submitted_at) VALUES('sub_activation',?,?,1,'{}',?,'approved','staff_qa',?)").run(activation.editionId,activation.accountId,"a".repeat(64),at);
 activation.sql.prepare("INSERT INTO publishing_publications(id,submission_id,publishing_account_id,work_id,edition_id,product_id,materialization_key,published_at) VALUES('pub_activation','sub_activation',?,'work_activation','ed_activation','prd_activation','key_activation',?)").run(activation.accountId,at);
 activation.sql.prepare("INSERT INTO publishing_publication_versions(id,lifecycle_id,publication_id,submission_id,version_number,snapshot_sha256,manifest_json,release_state,created_by_user_id,created_at) VALUES('pubv_activation',?,'pub_activation','sub_activation',1,?,'{}','live','staff_qa',?)").run(life.id,"a".repeat(64),at);
 const event={lifecycleId:life.id,publicationVersionId:"pubv_activation",fromPublicationVersionId:null,activationType:"initial",actorUserId:"staff_qa",reasonCode:"ACTIVATE",metadata:{source:"owner"},at};
 activation.lose();await assert.rejects(helper.recordPublicationActivation(activation.db,event),/activation_lost_ack/);
 await helper.recordPublicationActivation(activation.db,event);await helper.recordPublicationActivation(activation.db,event);
 assert.equal(activation.sql.prepare("SELECT COUNT(*) n FROM publishing_publication_activations").get().n,1);
 assert.equal(activation.sql.prepare("PRAGMA foreign_key_check").all().length,0);
 assert.equal(party.sql.prepare("PRAGMA foreign_key_check").all().length,0);
 console.log("PASS: actual private publishing helpers atomically create lifecycle/history and canonical parties; lost ACK and duplicate recovery; concurrent state/compliance vetoes and no terminal-state reinstatement");
}finally{for(const db of stores)db.close();rmSync(folder,{recursive:true,force:true});}

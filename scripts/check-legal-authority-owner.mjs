/* eslint-disable prettier/prettier -- Assert revision ordering and deny-first behavior explicitly. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const directory=fs.mkdtempSync(path.join(os.tmpdir(),"cove-legal-fence-"));
try {
  const artifact=path.join(directory,"authority.mjs");
  await build({
    entryPoints:["src/storefront-strangler/legal-authority-core.ts"],
    outfile:artifact,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"
  });
  const {createAuthoritySchema, readAuthority, applyAuthorityCommand}=
    await import(pathToFileURL(artifact).href);
  const sqlitePath=path.join(directory,"persistent.sqlite");
  const makeSql=db=>({
    exec(statement,...args) {
      const run=db.prepare(statement);
      return {toArray:()=>run.all(...args)};
    }
  });
  let db=new DatabaseSync(sqlitePath);
  let sql=makeSql(db);
  createAuthoritySchema(sql);
  const cmd=(revision,action,territory="US")=>({
    sourceId:"2701",territory,revision,action
  });
  const state=(territory="US")=>readAuthority(sql,"2701",territory);
  assert.deepEqual(state(),{allowed:false,revision:null},
    "Cold/unseeded owner cannot infer authorization from a cached card");
  assert.equal(applyAuthorityCommand(sql,cmd(10,"deny")).applied,true);
  assert.deepEqual(state(),{allowed:false,revision:10});
  assert.equal(applyAuthorityCommand(sql,cmd(10,"deny")).applied,true,
    "Idempotent denial retry must acknowledge persisted denial");
  assert.equal(applyAuthorityCommand(sql,cmd(9,"allow")).applied,false);
  assert.equal(applyAuthorityCommand(sql,cmd(10,"allow")).applied,false);
  assert.equal(state().allowed,false);
  assert.equal(applyAuthorityCommand(sql,cmd(11,"allow")).applied,true);
  assert.deepEqual(state(),{allowed:true,revision:11});
  assert.equal(applyAuthorityCommand(sql,cmd(11,"deny")).applied,true,
    "Same-revision denial must dominate positive grant");
  assert.equal(applyAuthorityCommand(sql,cmd(11,"allow")).applied,false);
  assert.equal(state().allowed,false);
  assert.equal(applyAuthorityCommand(sql,cmd(12,"allow")).applied,true);
  assert.equal(state().allowed,true);
  // A global source withdrawal blocks every territory, including those with
  // previously allowed state. A later explicit fresh positive proof is needed.
  assert.equal(applyAuthorityCommand(sql,cmd(13,"deny","*")).applied,true);
  assert.equal(state().allowed,false);
  assert.deepEqual(state("CA"),{allowed:false,revision:13});
  assert.equal(applyAuthorityCommand(sql,cmd(13,"allow")).applied,true);
  assert.equal(state().allowed,false,
    "Global denial wins over equal-revision territory permission");
  assert.equal(applyAuthorityCommand(sql,cmd(14,"allow")).applied,true);
  assert.equal(state().allowed,true);
  assert.equal(state("CA").allowed,false,
    "US reinstatement cannot authorize an unrelated territory");
  assert.equal(applyAuthorityCommand(sql,cmd(12,"deny","*")).applied,false);
  assert.equal(state().allowed,true);
  assert.throws(()=>applyAuthorityCommand(sql,cmd(15,"allow","*")),/invalid_authority_command/);
  assert.throws(()=>applyAuthorityCommand(sql,cmd(0,"allow")),/invalid_authority_command/);
  assert.throws(()=>applyAuthorityCommand(sql,cmd(16,"allow","ZZZ")),/invalid_authority_command/);
  assert.throws(()=>applyAuthorityCommand(sql,{...cmd(17,"allow"),sourceId:"../../"},),/invalid_authority_command/);
  assert.throws(()=>readAuthority(sql,"2701","*"),/invalid_authority_scope/);
  // Simulated isolate eviction: state is reloaded from durable SQL, not a
  // settled in-memory cache or a soon-to-expire KV/R2 snapshot.
  db.close();
  db=new DatabaseSync(sqlitePath);
  sql=makeSql(db);
  createAuthoritySchema(sql);
  assert.deepEqual(state(),{allowed:true,revision:14});
  assert.equal(applyAuthorityCommand(sql,cmd(15,"deny")).applied,true);
  db.close();
  db=new DatabaseSync(sqlitePath);
  sql=makeSql(db);
  assert.deepEqual(state(),{allowed:false,revision:15});
  db.close();
  console.log("PASS: persistent deny-first legal fence, stale/equal positive rejection, global withdrawal, territory isolation, recovery");
} finally {fs.rmSync(directory,{recursive:true,force:true});}

/** Exact reversible additions from the reviewed operational protocol and
 * production account metadata bridge. Old owner pins are kept unchanged. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
const digest=value=>createHash("sha256").update(value).digest("hex");
const deltas={
  "src/storefront-strangler/legal-authority.worker.ts": [
    "import { QA_OPERATIONAL_ROUTE } from \"./qa-owner-operational-protocol\";\nimport { serveQaOperationalWrite } from \"./qa-owner-operational-execution\";\n",
    "  COVE_QA_OPERATIONAL_OWNER_ENABLED?: string;\n",
    "    if(route===QA_OPERATIONAL_ROUTE){\n      return serveQaOperationalWrite(request,env,this.ctx.storage as Parameters<typeof serveQaOperationalWrite>[2]);\n    }\n"
  ],
  "src/features/fore/search.server.ts": [
    "import { dispatchQaOperationalWrite } from \"../../storefront-strangler/qa-owner-operational-protocol\";\n",
    "  if (userId === null) {\n    const remote = dispatchQaOperationalWrite(db, {\n      kind: \"search.impression\",\n      id,\n      query: input.query,\n      normalizedQuery: normalizeQuery(input.query),\n      filtersJson: JSON.stringify({ ...filters, page: input.page, limit: input.limit }),\n      sort: input.sort,\n      count: data.count,\n      backend: data.backend as \"d1-fts5\" | \"meilisearch\",\n      duration: Math.max(0, Math.round(data.duration)),\n      correctedQuery: data.correctedQuery || null,\n      impressionsJson: JSON.stringify(impressions),\n      at: new Date().toISOString(),\n    });\n    if (remote) {\n      await remote;\n      return id;\n    }\n  }\n"
  ]
};
export function reverseOwnerCompletionDelta(path,source){
  for(const addition of deltas[path]||[]){
    assert.equal(source.split(addition).length,2,"Exact operational delta drift: "+path);
    source=source.replace(addition,"");
  }
  if(path==="src/storefront-strangler/legal-authority.worker.ts"){
    const start=source.indexOf("  /** Shared metadata-only account executor.");
    const end=source.indexOf("  /** Narrow production schedule bridge.",start);
    assert.ok(start>=0&&end>start,"Shared account metadata bridge must exist exactly once");
    const methods=source.slice(start,end);
    assert.equal(digest(methods),"78ab4830d587b9436527b367ee89c96308300468994fbaccd2ca84d7a3491a01","Only exact reviewed metadata extraction/production admission is allowed");
    const bodyStart=methods.indexOf('    const noStore={"cache-control":"no-store"};\n')+'    const noStore={"cache-control":"no-store"};\n'.length;
    const bodyEnd=methods.indexOf('  }\n\n  protected async productionAccountMetadata');
    const inner=methods.slice(bodyStart,bodyEnd);
    const dispatch='      if(route==="/account/private-action")return await this.#accountMetadataCommand(raw);\n';
    assert.equal(source.split(dispatch).length,2,"Shared account metadata dispatch must be exact");
    source=source.replace(methods,"").replace(dispatch,'      if(route==="/account/private-action"){\n'+inner+'      }\n');
  }
  return source;
}

import assert from "node:assert/strict";
import fs from "node:fs";
import { build } from "esbuild";

// Execute the REAL productDetail implementation against dependency stubs,
// not a copied approximation of its Promise.all schedule or legal response.
const source = fs.readFileSync("src/features/fore/retail.server.ts", "utf8");
const start = source.indexOf("export async function productDetail(");
const end = source.indexOf("export async function previewPolicy(", start);
assert.ok(start >= 0 && end > start);
const detail = source.slice(start, end);
const fanout = detail.slice(
  detail.indexOf("] = await Promise.all(["),
  detail.indexOf("const source = String(product.source_name)"),
);
for (const name of [
  "digital_assets",
  "publishing_publications",
  "edition_taxonomy_nodes",
  "preview_policies",
  "product_rankings",
  "FROM editions e JOIN products p",
  "FROM reviews",
  "FROM wishlist_items",
]) {
  assert.ok(fanout.includes(name), "Independent public metadata read must join fanout: " + name);
}
assert.ok(
  detail.indexOf("const [rights, channelFlags, preorder]") >
    detail.indexOf("] = await Promise.all(["),
);
assert.ok(
  detail.indexOf("const editionOffers = await Promise.all") >
    detail.indexOf("const [rights, channelFlags, preorder]"),
);
assert.doesNotMatch(detail, /\b(?:UPDATE|INSERT INTO|DELETE FROM)\b/i);

const stubs = {
  "./service": `export class ApiError extends Error { constructor(status, message) {super(message);this.status=status;} }`,
  "./catalog-model.server": `
    export async function getCanonicalBook() {
      return { id:"1342", productId:"p1", editionId:"e1", workId:"w1",
        sourceExternalId:"1342", title:"Test", downloadable:true };
    }
    export async function resolveProduct() {
      return { id:"p1", source_name:"gutenberg" };
    }
    export async function canonicalBooksByProductIds() { return []; }
  `,
  "./pricing.server": `
    export async function resolvePricingDecision(_db,id) {
      return globalThis.__detailProbe.run("price:"+id, {
        offerId:"o1", currency:"USD", amountMinor:500, listAmountMinor:500,
        taxBehavior:"exclusive",taxCode:"",promotion:null
      });
    }
  `,
  "./rights.server": `
    export async function resolveProductRights() {
      const p=globalThis.__detailProbe;
      const out=await p.run("rights", { allowed:p.allowed, reasonCode:p.allowed?"allowed":"withdrawn",
        grantId:p.allowed?"grant":"",licenseType:"agency",drmRequirement:"none" });
      if(p.failRights)throw new Error("rights unavailable");
      return out;
    }
    export async function resolveRightsDecision() {return {allowed:false};}
  `,
  "./preorder.server": `
    export async function preorderPurchaseState() {
      return globalThis.__detailProbe.run("preorder", {
        isPreorder:false, accepting:true,reason:null,plan:null,existing:null
      });
    }
    export async function assertPreorderPurchaseAllowed() {}
  `,
  "./retail-intelligence.server": `export async function recordRetailEvent() {}`,
  "./notifications.server": `export async function emitNotification() {}`,
  "./sync.server": `export async function recordSyncProjection() {}`,
};
const { outputFiles } = await build({
  entryPoints: ["src/features/fore/retail.server.ts"],
  platform: "node",
  format: "esm",
  bundle: true,
  write: false,
  plugins: [
    {
      name: "read-fanout-deps",
      setup(build) {
        build.onResolve({ filter: /^\.\// }, (args) => {
          if (!args.importer.endsWith("retail.server.ts") || !(args.path in stubs)) return;
          return { path: args.path, namespace: "retail-read-probe" };
        });
        build.onLoad({ filter: /.*/, namespace: "retail-read-probe" }, (args) => ({
          contents: stubs[args.path],
          loader: "js",
        }));
      },
    },
  ],
});
const { productDetail } = await import(
  "data:text/javascript;base64," + Buffer.from(outputFiles[0].text).toString("base64")
);

function probe(allowed, failRights = false) {
  return {
    allowed,
    failRights,
    active: 0,
    maxActive: 0,
    events: [],
    async run(label, value) {
      this.active++;
      this.maxActive = Math.max(this.maxActive, this.active);
      this.events.push("start:" + label);
      await new Promise((resolve) => setTimeout(resolve, 20));
      this.events.push("end:" + label);
      this.active--;
      return value;
    },
  };
}
const db = {
  prepare(sql) {
    const value = () => {
      if (sql.includes("FROM entitlements")) return null;
      if (sql.includes("FROM reviews"))
        return { review_count: 2, average_rating: 4.5, five_star: 1 };
      if (sql.includes("FROM wishlist_items")) return { alert_price_drop: 1 };
      if (sql.includes("FROM preview_policies"))
        return { mode: "percent", limit_value: 10, max_percentage: 20, version: 1 };
      if (sql.includes("FROM digital_assets")) return { drm_status: "none", downloadable: 1 };
      if (sql.includes("FROM publishing_publications"))
        return { policy_version: "v1", public_badges_json: "[]" };
      if (sql.includes("FROM product_rankings")) return [];
      if (sql.includes("FROM edition_taxonomy_nodes")) return [];
      if (sql.includes("FROM product_channel_availability"))
        return [{ sales_channel: "subscription" }];
      if (sql.includes("FROM editions e JOIN products p"))
        return [
          {
            product_id: "p1",
            edition_id: "e1",
            edition_public_id: "e1",
            source_external_id: "1342",
            language: "en",
            format: "ebook",
          },
        ];
      throw new Error("Unexpected SQL read " + sql.slice(0, 75));
    };
    const label = () => {
      if (sql.includes("FROM digital_assets")) return "distribution";
      if (sql.includes("FROM editions e JOIN products p")) return "edition-rows";
      if (sql.includes("FROM publishing_publications")) return "disclosure";
      if (sql.includes("FROM product_channel_availability")) return "channel";
      return "metadata";
    };
    const execute = async () => globalThis.__detailProbe.run(label(), value());
    return {
      bind() {
        return this;
      },
      async first() {
        const x = await execute();
        return Array.isArray(x) ? x[0] || null : x;
      },
      async all() {
        const x = await execute();
        return { results: Array.isArray(x) ? x : [] };
      },
    };
  },
};
globalThis.__detailProbe = probe(true);
const allowed = await productDetail(db, "1342", "u1", "US");
assert.equal(allowed.commerce.rights.allowed, true);
assert.equal(allowed.commerce.canReadFull, true);
assert.equal(allowed.commerce.offer.amountMinor, 500);
assert.equal(allowed.preview.available, true);
assert.equal(allowed.editions.length, 1);
assert.equal(allowed.wishlist.saved, true);
assert.ok(
  globalThis.__detailProbe.maxActive >= 8,
  "Independent detail projections must overlap, not serialize after rights checks",
);
for (const completed of ["end:edition-rows", "end:distribution", "end:disclosure"]) {
  assert.ok(
    globalThis.__detailProbe.events.indexOf(completed) <
      globalThis.__detailProbe.events.indexOf("start:rights"),
    "Every required read finishes before the authorization-dependent response: " + completed,
  );
}
globalThis.__detailProbe = probe(false);
const denied = await productDetail(db, "1342", null, "US");
assert.equal(denied.commerce.rights.allowed, false);
assert.equal(denied.commerce.canReadFull, false);
assert.equal(denied.preview.available, false);
globalThis.__detailProbe = probe(true, true);
await assert.rejects(productDetail(db, "1342", null, "US"), /rights unavailable/);
delete globalThis.__detailProbe;
console.log(
  "PASS: real product detail overlaps independent reads, preserves offers, denies withdrawn rights, and fails closed",
);

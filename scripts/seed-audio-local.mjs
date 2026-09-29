// Loads the validated catalog and any locally prepared recordings through the
// same Worker endpoints used in production. This is for integration QA only.
import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const root = process.cwd(),
  runtime = path.join(root, ".sites-runtime"),
  entry = path.join(runtime, "seed-api.mjs");
await build({
  entryPoints: ["src/features/fore/api.server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: entry,
  logLevel: "silent",
});
const { handleCoveApi } = await import(entry + "?v=" + Date.now());
const env = localBindings(root);
Object.assign(env, { FORE_AUTH_MODE: "supabase" });
const localSecret=randomBytes(32).toString("base64url"),localPrefix=randomBytes(6).toString("hex"),serviceToken=`fore_svc_${localPrefix}.${localSecret}`,at=new Date().toISOString();
await env.DB.prepare("INSERT OR IGNORE INTO service_principals(id,name,description,owner_team,environment,status,created_at,updated_at) VALUES('svc_local_seed','local-seed','Local integration fixture only','development','development','active',?,?)").bind(at,at).run();
for(const scope of ["catalog.ingest","audio.prepare"])await env.DB.prepare("INSERT OR IGNORE INTO service_principal_scopes(principal_id,scope,granted_at) VALUES('svc_local_seed',?,?)").bind(scope,at).run();
await env.DB.prepare("INSERT INTO service_principal_credentials(id,principal_id,token_prefix,token_sha256,status,not_before,expires_at,created_at) VALUES(?,?,?,?, 'active',?,?,?)").bind(`cred_${crypto.randomUUID()}`,'svc_local_seed',localPrefix,createHash('sha256').update(serviceToken).digest('hex'),at,new Date(Date.now()+3600000).toISOString(),at).run();
async function call(route, method = "GET", body, headers = {}) {
  const binary = body instanceof Uint8Array;
  const response = await handleCoveApi(
    new Request("http://localhost/api/fore" + route, {
      method,
      headers: {
        authorization: "Bearer " + serviceToken,
        origin: "http://localhost",
        ...(binary
          ? {
              "content-type": "application/octet-stream",
              "content-length": String(body.byteLength),
            }
          : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
    }),
    env,
  );
  const text = await response.text();
  if (!response.ok) throw Error(route + " " + response.status + " " + text.slice(0, 500));
  return text ? JSON.parse(text) : null;
}
const pipeline = path.join(runtime, "pipeline"),
  editions = JSON.parse(fs.readFileSync(path.join(pipeline, "editions.json"), "utf8"));
for (let i = 0; i < editions.length; i++) {
  await call("/pipeline/edition", "PUT", editions[i]);
  if ((i + 1) % 100 === 0) console.log("Local catalog", i + 1);
}
for (const name of fs.readdirSync(pipeline).filter((v) => v.startsWith("pg-"))) {
  const folder = path.join(pipeline, name),
    prepared = path.join(folder, "prepared.json");
  if (!fs.existsSync(prepared)) continue;
  const payload = JSON.parse(fs.readFileSync(prepared, "utf8"));
  payload.edition.alignment = null;
  await call("/pipeline/edition", "PUT", payload);
  await call(
    "/pipeline/book",
    "PUT",
    JSON.parse(fs.readFileSync(path.join(folder, "book.json"), "utf8")),
  );
  for (const track of payload.edition.tracks) {
    const file = fs.readFileSync(path.join(folder, payload.fingerprints[track.id] + ".audio"));
    await call(`/pipeline/media/${payload.edition.id}/${track.id}`, "PUT", file, {
      "x-content-sha256": track.sha256,
      "x-audio-duration": String(track.duration),
      "x-source-url": track.url,
    });
  }
  const epub = fs.readFileSync(path.join(folder, "book.epub"));
  await call("/pipeline/text/" + payload.edition.id, "PUT", epub, {
    "x-content-sha256": payload.edition.epubSha256,
    "x-book-id": payload.edition.bookId,
  });
  let checked = 0;
  for (const filename of fs.readdirSync(folder).filter((v) => v.endsWith(".map.json"))) {
    const map = JSON.parse(fs.readFileSync(path.join(folder, filename), "utf8"));
    if (map.status === "checked") {
      await call(`/pipeline/alignment/${payload.edition.id}/${map.trackId}`, "PUT", map);
      checked++;
    }
  }
  console.log("Local prepared", payload.edition.id, checked + "/" + payload.edition.tracks.length);
}
console.log(await call("/audio-status"));

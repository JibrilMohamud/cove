import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export function localBindings(root) {
  const dir = path.join(root, ".sites-runtime");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "fore.sqlite"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("CREATE TABLE IF NOT EXISTS __local_migrations (name TEXT PRIMARY KEY)");
  const migrationDir = path.join(root, "drizzle");
  if (fs.existsSync(migrationDir))
    for (const name of fs
      .readdirSync(migrationDir)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      if (!db.prepare("SELECT name FROM __local_migrations WHERE name=?").get(name)) {
        db.exec(fs.readFileSync(path.join(migrationDir, name), "utf8"));
        db.prepare("INSERT INTO __local_migrations(name) VALUES(?)").run(name);
      }
    }
  function statement(sql, values = []) {
    const s = db.prepare(sql);
    return {
      bind(...v) {
        return statement(sql, v);
      },
      async first() {
        return s.get(...values) || null;
      },
      async all() {
        return { results: s.all(...values) };
      },
      async run() {
        return s.run(...values);
      },
    };
  }
  const bucket = path.join(dir, "bucket");
  fs.mkdirSync(bucket, { recursive: true });
  const objectPath = (key) => {
    const dest = path.resolve(bucket, key);
    if (!dest.startsWith(bucket + path.sep)) throw Error("Invalid object path");
    return dest;
  };
  return {
    DB: {
      prepare: statement,
      async batch(statements) {
        db.exec("BEGIN");
        try {
          const results = [];
          for (const s of statements) results.push(await s.run());
          db.exec("COMMIT");
          return results;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    },
    BUCKET: {
      async head(key) {
        const p = objectPath(key);
        return fs.existsSync(p) ? { size: fs.statSync(p).size } : null;
      },
      async get(key, options) {
        const p = objectPath(key);
        if (!fs.existsSync(p)) return null;
        const size=fs.statSync(p).size;
        return {
          body:Readable.toWeb(fs.createReadStream(p,options?.range?{start:options.range.offset,end:options.range.offset+options.range.length-1}:{})),
          size,
        };
      },
      async put(key, bytes, options) {
        const p = objectPath(key);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const temp = p + "." + randomUUID() + ".part";
        try {
          if (bytes?.getReader) await pipeline(Readable.fromWeb(bytes), fs.createWriteStream(temp));
          else fs.writeFileSync(temp, Buffer.from(bytes));
          if (options?.sha256) {
            const hash = createHash("sha256");
            for await (const chunk of fs.createReadStream(temp)) hash.update(chunk);
            if (hash.digest("hex") !== options.sha256) throw Error("Checksum mismatch");
          }
          fs.renameSync(temp, p);
        } finally {
          fs.rmSync(temp, { force: true });
        }
      },
      async delete(key) {
        fs.rmSync(objectPath(key), { force: true });
      },
    },
  };
}
export function foreApiDevPlugin() {
  let env;
  return {
    name: "fore-local-api",
    configureServer(server) {
      env = {
        ...localBindings(server.config.root),
        FORE_AUTH_MODE: process.env.FORE_AUTH_MODE||"supabase",
        SUPABASE_URL:process.env.SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY:process.env.SUPABASE_PUBLISHABLE_KEY,
        FORE_GOOGLE_ENABLED:process.env.FORE_GOOGLE_ENABLED,
        FORE_PUBLIC_URL:process.env.FORE_PUBLIC_URL,
        FORE_STAFF_BOOTSTRAP_TOKEN:process.env.FORE_STAFF_BOOTSTRAP_TOKEN,
        FORE_ALERT_WEBHOOK_URL:process.env.FORE_ALERT_WEBHOOK_URL,
        FORE_ALERT_WEBHOOK_TOKEN:process.env.FORE_ALERT_WEBHOOK_TOKEN,
        FORE_ERROR_REPORTING_URL:process.env.FORE_ERROR_REPORTING_URL,
        FORE_ERROR_REPORTING_TOKEN:process.env.FORE_ERROR_REPORTING_TOKEN,
        GUTENBERG_MIRROR_BASE_URL: process.env.GUTENBERG_MIRROR_BASE_URL,
        GUTENDEX_BASE_URL: process.env.GUTENDEX_BASE_URL,
        FORE_SEARCH_BACKEND: process.env.FORE_SEARCH_BACKEND,
        FORE_SEARCH_URL: process.env.FORE_SEARCH_URL,
        FORE_SEARCH_SEARCH_KEY: process.env.FORE_SEARCH_SEARCH_KEY,
        FORE_SEARCH_ADMIN_KEY: process.env.FORE_SEARCH_ADMIN_KEY,
        FORE_SEARCH_INDEX: process.env.FORE_SEARCH_INDEX,
        FORE_SEARCH_EMBEDDER: process.env.FORE_SEARCH_EMBEDDER,
        FORE_RECOMMENDER_URL: process.env.FORE_RECOMMENDER_URL,
        FORE_RECOMMENDER_API_KEY: process.env.FORE_RECOMMENDER_API_KEY,
        FORE_RECOMMENDER_MODEL: process.env.FORE_RECOMMENDER_MODEL,
      };
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/fore/")) return next();
        try {
          const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,body:["GET","HEAD"].includes(req.method)?undefined:Readable.toWeb(req),duplex:"half"});
          const { handleCoveApi } = await server.ssrLoadModule("/src/features/fore/api.server.ts");
          const response = await handleCoveApi(request, env);
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          if (response.body) await pipeline(Readable.fromWeb(response.body), res);
          else res.end();
        } catch (e) {
          console.error(e);
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "The local service is unavailable." }));
        }
      });
    },
  };
}

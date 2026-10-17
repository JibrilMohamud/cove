import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { cp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const output = ".offline-dist";
await build({
  configFile: false,
  publicDir: false,
  plugins: [react(), tailwind()],
  resolve: { alias: { "@": path.resolve("src") } },
  build: {
    outDir: output,
    emptyOutDir: true,
    rollupOptions: { input: path.resolve("offline.html") },
    assetsDir: "offline-assets",
  },
  logLevel: "warn",
});
async function files(dir) {
  const all = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) all.push(...(await files(p)));
    else all.push(p);
  }
  return all;
}
const paths = await files(output);
const assets = paths.map((p) => "/" + path.relative(output, p).split(path.sep).join("/")).sort();
if (
  !assets.includes("/offline.html") ||
  assets.some(
    (asset) => asset !== "/offline.html" && !/^\/offline-assets\/[A-Za-z0-9_.-]+$/.test(asset),
  )
)
  throw Error("Offline build contains assets the service worker cannot install");
const version = createHash("sha256")
  .update(await readFile(path.join(output, "offline.html")))
  .update(assets.join("\n"))
  .digest("hex")
  .slice(0, 20);
await writeFile(path.join(output, "offline-manifest.json"), JSON.stringify({ version, assets }));
await writeFile(
  path.join(output, "sw.js"),
  (await readFile("public/sw.js", "utf8")).replaceAll("__COVE_OFFLINE_BUILD__", version),
);
for (const destination of process.env.VERCEL ? [".vercel/output/static"] : [".output/public"]) {
  await mkdir(destination, { recursive: true });
  await cp(output, destination, { recursive: true });
}
await rm(output, { recursive: true, force: true });
console.log(`Offline reader ${version}: ${assets.length} versioned shell assets staged.`);

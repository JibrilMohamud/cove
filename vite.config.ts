// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { NitroConfig } from "nitro/types";

import { foreApiDevPlugin } from "./scripts/local-api.mjs";

const isVercelBuild = Boolean(process.env.VERCEL && process.env.VERCEL !== "0");
const isCloudflarePilotBuild = process.env.COVE_CLOUDFLARE_SSR_PILOT === "1";
// The Lovable wrapper forwards Nitro options, but exposes a narrower type.
// Validate the complete preset with Nitro's own schema before passing it on.
const cloudflarePilotConfig = {
  preset: "cloudflare-module",
  // Workers provides performance natively. Nitro's generic nodeless
  // injection put its shim in the same shared chunk as epubjs, making
  // the first SSR entry eagerly evaluate reader/XML dependencies
  // before our request timer even starts.
  unenv: { inject: { performance: false } },
} satisfies NitroConfig;

export default defineConfig({
  plugins: [foreApiDevPlugin()],
  vite: {
    server: {
      host: "0.0.0.0",
      port: 4173,
      strictPort: true,
      allowedHosts: ["terminal.local"],
    },
  },
  nitro: isVercelBuild
    ? { preset: "vercel" }
    : isCloudflarePilotBuild
      ? cloudflarePilotConfig
      : true,
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});

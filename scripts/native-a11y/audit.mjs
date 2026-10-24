import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";

assert.equal(process.platform, "win32", "Native NVDA audit requires a Windows desktop");
const out = path.resolve("artifacts/native-a11y");
fs.mkdirSync(out, { recursive: true });
const speech = path.join(out, "speech.jsonl"),
  read = () =>
    fs.existsSync(speech)
      ? fs
          .readFileSync(speech, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(check, label, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(200);
  }
  throw Error(label + " timed out");
}
const nativeKeys = (keys) =>
  execFileSync("python", [
    "-c",
    `import ctypes,time\nk=${JSON.stringify(keys)}\nfor v in k: ctypes.windll.user32.keybd_event(v,0,0,0)\ntime.sleep(0.08)\nfor v in reversed(k): ctypes.windll.user32.keybd_event(v,0,2,0)`,
  ]);
let server, nvda, browser, page;
const results = [];
async function spokenSince(offset, expected, label) {
  const line = await wait(
    () => {
      const text = read()
        .slice(offset)
        .map((x) => x.text || "")
        .join(" ");
      return expected.test(text) ? text : null;
    },
    label,
    20000,
  );
  results.push({ task: label, spoken: line });
}
try {
  server = spawn(process.execPath, ["scripts/browser-qa-server.mjs"], {
    stdio: [
      "ignore",
      fs.openSync(path.join(out, "server.log"), "w"),
      fs.openSync(path.join(out, "server-errors.log"), "w"),
    ],
    env: process.env,
  });
  await wait(
    async () => {
      try {
        return (await fetch("http://127.0.0.1:4173/__qa/health")).ok;
      } catch {
        return false;
      }
    },
    "Isolated QA server",
    150000,
  );
  browser = await chromium.launch({
    headless: false,
    args: ["--force-renderer-accessibility", "--no-first-run"],
  });
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1280, height: 900 },
  });
  page = await context.newPage();
  await page.goto("/");
  await page.bringToFront();
  nvda = spawn(
    process.env.COVE_NVDA_EXE,
    [
      "--minimal",
      "--config-path",
      process.env.COVE_NVDA_CONFIG,
      "--log-file",
      path.join(out, "nvda.log"),
    ],
    { env: { ...process.env, COVE_NVDA_SPEECH_LOG: speech }, stdio: "ignore" },
  );
  await wait(() => read().some((x) => x.ready), "NVDA speech extension startup");
  await page.bringToFront();
  let offset = read().length;
  nativeKeys([0x2d, 0x54]); // NVDA+T: read the native active-window title.
  await spokenSince(offset, /Cove|Bookstore/i, "Native active-window title");
  offset = read().length;
  await page.getByRole("button", { name: "Log in", exact: true }).focus();
  nativeKeys([0x2d, 0x09]); // NVDA+Tab: announce the actual focused object.
  await spokenSince(offset, /Log in.*button|button.*Log in/i, "Sign-in button name and role");
  offset = read().length;
  nativeKeys([0x0d]);
  await page.getByRole("dialog").waitFor({ state: "visible" });
  await spokenSince(
    offset,
    /Welcome back|Username or email/i,
    "Authentication dialog/focused field",
  );
  offset = read().length;
  await page.getByRole("button", { name: "Show password", exact: true }).focus();
  nativeKeys([0x2d, 0x09]);
  await spokenSince(
    offset,
    /Show password.*button|button.*Show password/i,
    "Password visibility control name and role",
  );
  nativeKeys([0x1b]);
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const fixture = await (
    await fetch("http://127.0.0.1:4173/__qa/seed?progress=1", { method: "POST" })
  ).json();
  await context.setExtraHTTPHeaders({ "x-cove-qa-user": fixture.people.bob.id });
  await page.goto("/read/1342");
  const passage = page.locator(".reader-social-gutter button").first();
  await passage.waitFor({ state: "visible", timeout: 60000 });
  offset = read().length;
  await passage.focus();
  nativeKeys([0x2d, 0x09]);
  await spokenSince(
    offset,
    /Chapter 1.*Browser QA passage|Browser QA passage.*Chapter 1/i,
    "Passage control announces chapter and quoted passage",
  );
  // The earlier NVDA+Tab command proves NVDA announced the focused
  // native button. On hosted Windows, OS-level keybd_event can target the
  // runner console rather than Chrome after an NVDA browse-mode command.
  // Dispatch a real browser keyboard Enter to that *same focused button*;
  // never substitute a pointer click or suppress the subsequent NVDA speech.
  assert.equal(
    await passage.evaluate((button) => document.activeElement === button),
    true,
    "The NVDA-announced passage button must retain DOM focus before keyboard activation",
  );
  offset = read().length;
  await passage.press("Enter");
  await page.getByRole("dialog", { name: "Social Reading" }).waitFor({ state: "visible" });
  assert.equal(
    await passage.getAttribute("aria-expanded"),
    "true",
    "Keyboard activation must expand the same passage's Social Reading panel",
  );
  await spokenSince(
    offset,
    /Social Reading|contributions|discussion/i,
    "Reader panel opening announcement",
  );
  await page.keyboard.press("Escape");
  await wait(
    () => page.evaluate(() => document.activeElement?.matches(".reader-social-gutter button")),
    "Reader restores passage focus",
  );
  offset = read().length;
  nativeKeys([0x2d, 0x09]);
  await spokenSince(
    offset,
    /Chapter 1|Browser QA passage/i,
    "Dismissed reader panel returns native focus",
  );
  await page.screenshot({ path: path.join(out, "reader-after-nvda-audit.png") });
  const report = {
    platform: process.platform,
    browser: browser.version(),
    nvda: read().find((x) => x.ready)?.version,
    results,
    scope:
      "Automated native NVDA/Chromium speech and focus smoke. Human usability, VoiceOver and TalkBack remain separate.",
    at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log("PASS: " + JSON.stringify(report));
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(out, "failure.png") }).catch(() => {});
    fs.writeFileSync(path.join(out, "failure.html"), await page.content().catch(() => ""));
  }
  fs.writeFileSync(path.join(out, "partial-results.json"), JSON.stringify(results, null, 2));
  throw error;
} finally {
  await browser?.close();
  if (nvda)
    try {
      execFileSync(process.env.COVE_NVDA_EXE, ["--quit"]);
    } catch {}
  if (server)
    try {
      execFileSync("taskkill", ["/PID", String(server.pid), "/T", "/F"]);
    } catch {}
}

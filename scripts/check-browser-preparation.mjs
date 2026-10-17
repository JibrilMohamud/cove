import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cove-worker-preparation-"));
const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
try {
  await build({
    entryPoints: ["src/features/fore/service-worker.ts"],
    outfile: path.join(root, "worker.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { coveServiceWorkerReady } = await import(path.join(root, "worker.mjs"));
  const mock = (serviceWorker) =>
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { serviceWorker },
    });
  class InstallingWorker extends EventTarget {
    state = "installing";
    listeners = new Set();
    addEventListener(...args) {
      this.listeners.add(args[1]);
      super.addEventListener(...args);
    }
    removeEventListener(...args) {
      this.listeners.delete(args[1]);
      super.removeEventListener(...args);
    }
    change(state) {
      this.state = state;
      this.dispatchEvent(new Event("statechange"));
    }
  }
  let release;
  const worker = new InstallingWorker();
  const registration = { installing: worker };
  mock({
    register: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    ready: Promise.resolve(registration),
  });
  await assert.rejects(coveServiceWorkerReady(15), /timed out/);
  release(registration);
  await new Promise(setImmediate);
  assert.equal(
    worker.listeners.size,
    0,
    "a late registration cannot retain listeners after timeout",
  );

  mock({ register: async () => registration, ready: Promise.resolve(registration) });
  const preparing = coveServiceWorkerReady();
  await new Promise(setImmediate);
  worker.change("installed");
  assert.equal(await preparing, registration);
  assert.equal(worker.listeners.size, 0);

  const failed = new InstallingWorker();
  failed.state = "redundant";
  mock({ register: async () => ({ installing: failed }), ready: new Promise(() => {}) });
  await assert.rejects(coveServiceWorkerReady(), /setup failed/);
  assert.equal(failed.listeners.size, 0);

  mock({ register: async () => ({ installing: null }), ready: new Promise(() => {}) });
  await assert.rejects(coveServiceWorkerReady(15), /timed out/);
  const ready = { installing: null };
  mock({ register: async () => ready, ready: Promise.resolve(ready) });
  assert.equal(
    await coveServiceWorkerReady(),
    ready,
    "a retry can recover after activation stalls",
  );
  console.log(
    "PASS: requested browser setup has bounded registration/activation, rejects failed installs, cleans late listeners and retries safely.",
  );
} finally {
  if (previous) Object.defineProperty(globalThis, "navigator", previous);
  else delete globalThis.navigator;
  await fs.rm(root, { recursive: true, force: true });
}

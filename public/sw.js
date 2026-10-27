// Stamped by the offline build; only public static assets enter Cache Storage.
const SHELL_BUILD = "__COVE_OFFLINE_BUILD__";
const CACHE = `cove-shell-${SHELL_BUILD}`;
const STATIC = `cove-static-${SHELL_BUILD}`;
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const response = await fetch("/offline-manifest.json", { cache: "no-store" });
      if (!response.ok) throw Error("Offline manifest unavailable");
      const manifest = await response.json();
      if (
        manifest.version !== SHELL_BUILD ||
        !Array.isArray(manifest.assets) ||
        !manifest.assets.includes("/offline.html")
      )
        throw Error("Offline shell version mismatch");
      const cache = await caches.open(CACHE);
      try {
        for (const asset of manifest.assets) {
          if (asset !== "/offline.html" && !/^\/offline-assets\/[A-Za-z0-9_.-]+$/.test(asset))
            throw Error("Unexpected offline asset");
          const r = await fetch(asset, { cache: "reload" });
          if (!r.ok || r.redirected) throw Error("Incomplete offline shell");
          await cache.put(asset, r);
        }
      } catch (error) {
        await caches.delete(CACHE);
        throw error;
      }
      // Avoid replacing a running reader in the middle of a chapter. A complete
      // new worker activates naturally after older clients close.
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (
          (key.startsWith("cove-shell-") ||
            key.startsWith("cove-static-") ||
            key === "fore-shell-v1") &&
          key !== CACHE &&
          key !== STATIC
        )
          await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  )
    return;
  if (
    request.mode === "navigate" &&
    url.pathname === "/" &&
    url.searchParams.get("_cove_reconnect") === "1"
  ) {
    // Explicit reconnect must never return the same offline document.
    // This preserves cached books and never caches private HTML.
    event.respondWith(
      fetch(request, { cache: "no-store" }).catch(
        () =>
          new Response(
            '<!doctype html><html lang="en"><meta charset="utf-8">' +
              '<meta name="viewport" content="width=device-width,initial-scale=1">' +
              "<title>Cove — Connection unavailable</title>" +
              "<main><h1>Online Cove is unavailable</h1>" +
              "<p>Cove could not reach its server. Your saved books remain on this device.</p>" +
              '<p><a href="/downloads">Return to saved books</a></p></main></html>',
            {
              status: 503,
              headers: {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
                "content-security-policy": "default-src 'none'; style-src 'none'; base-uri 'none'",
              },
            },
          ),
      ),
    );
    return;
  }
  if (request.mode === "navigate") {
    // Network documents may contain account data, entitlements or OAuth state.
    // They are never persisted, including signed-out/personalized catalog HTML.
    event.respondWith(
      (async () => {
        try {
          if (self.navigator?.onLine === false) throw Error("offline");
          return await fetch(request, { cache: "no-store" });
        } catch {
          return (
            (await (await caches.open(CACHE)).match("/offline.html")) ||
            new Response("Cove is offline. Reconnect once to prepare offline reading.", {
              status: 503,
              headers: { "Content-Type": "text/plain" },
            })
          );
        }
      })(),
    );
    return;
  }
  if (url.pathname.startsWith("/offline-assets/")) {
    event.respondWith(
      (async () => (await (await caches.open(CACHE)).match(url.pathname)) || fetch(request))(),
    );
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC),
          cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && !response.redirected) {
          await cache.put(request, response.clone());
          const keys = await cache.keys();
          for (const key of keys.slice(0, Math.max(0, keys.length - 120))) await cache.delete(key);
        }
        return response;
      })(),
    );
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {
    data = { body: event.data?.text() || "" };
  }
  const n = data.notification || data;
  event.waitUntil(
    (async () => {
      // Reading takes priority over all notification types and preferences.
      // Visible reader clients prevent the system notification from appearing.
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (
        clients.some((client) => {
          const url = new URL(client.url);
          return (
            client.visibilityState === "visible" &&
            (url.pathname.startsWith("/read/") || url.pathname.startsWith("/reader/"))
          );
        })
      )
        return;
      await self.registration.showNotification(n.title || "Cove", {
        body: n.body || "",
        icon: "/icons/cove-192.png",
        badge: "/icons/cove-192.png",
        data: { url: n.actionUrl || "/notifications" },
        tag: n.id || n.type || undefined,
        renotify: false,
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/notifications";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ("focus" in c) {
          c.navigate?.(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});

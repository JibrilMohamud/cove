const retryableStatuses = new Set([429, 500, 502, 503, 504]);

function retryDelayMs(response: Response | null, attempt: number) {
  const raw = response?.headers.get("retry-after")?.trim() || "";
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10_000, seconds * 1000);
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.min(10_000, Math.max(0, at - Date.now()));
  }
  return attempt === 0 ? 1_000 : 3_000;
}

export async function fetchCatalogPage(sourceUrl: string): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response | null = null;
    try {
      response = await fetch(sourceUrl, {
        headers: {
          Accept: "application/json",
          "User-Agent": "CoveReader/1.0 (persistent Gutenberg catalog harvester)",
        },
        signal: AbortSignal.timeout(30_000),
      });
      // The request deadline remains active while consuming the body. Await
      // JSON here so a body timeout/truncated response receives the same bounded
      // retries as a connection failure, before any D1 writes or cursor advance.
      if (response.ok) return await response.json();
      throw new Error("Catalog source returned " + response.status);
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      if (attempt === 2 || (response && !response.ok && !retryableStatuses.has(response.status))) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response, attempt)));
  }
  throw new Error("Catalog source request failed.");
}

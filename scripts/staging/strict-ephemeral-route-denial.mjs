/**
 * A just-deployed ephemeral, private Worker may briefly yield a Cloudflare
 * runtime 500/503/522 even after a successful attestation. Those statuses
 * NEVER prove route denial. Only the verifier's own exact 404/no-store reply
 * satisfies the security gate; 200 and every unrelated status fail at once.
 */
export async function requirePrivateVerifierNotFound(
  probe,
  { attempts = 4, pause = () => new Promise((resolve) => setTimeout(resolve, 750)) } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 6) {
    throw new Error("Invalid bounded private verifier attempts");
  }
  for (let index = 0; index < attempts; index++) {
    let response;
    try {
      response = await probe();
    } catch {
      throw new Error("Private verifier route failed before an HTTP response");
    }
    const noStore = /\bno-store\b/i.test(response?.headers?.get("cache-control") || "");
    if (response?.status === 404 && noStore) return response;
    try {
      await response?.body?.cancel();
    } catch {
      // The HTTP status remains authoritative even when cleanup fails.
    }
    if (response?.status === 200) {
      throw new Error("Private verifier unexpectedly exposed a disallowed route");
    }
    if (![500, 503, 522].includes(response?.status)) {
      throw new Error("Private verifier did not return its exact 404/no-store denial");
    }
    if (index + 1 < attempts) await pause();
  }
  throw new Error("Private verifier never returned exact 404/no-store after bounded retries");
}

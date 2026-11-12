/**
 * A recently attached owned Cloudflare TLS route can briefly return an edge
 * 404/503/522 before the authentication-only gateway can respond.
 * Transient transport failures are NEVER treated as secure denials: a final
 * exact 401 with its security headers is mandatory.
 *
 * This is for security probes only, not for performance samples.
 */
export async function requireOwnedCanaryDenial(
  probe,
  { attempts = 3, pause = () => new Promise((resolve) => setTimeout(resolve, 750)) } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 6) {
    throw new Error("Invalid bounded owned-canary probe attempts");
  }
  for (let index = 0; index < attempts; index++) {
    let response;
    try {
      response = await probe();
    } catch {
      throw new Error("Owned-canary security probe failed before receiving an HTTP response");
    }
    if (response?.status === 401) return response;
    await response?.body?.cancel();
    if (response?.status === 200) {
      throw new Error("Owned-canary path exposed public content to an invalid credential");
    }
    if (![404, 503, 522].includes(response?.status)) {
      throw new Error("Owned-canary denial did not return the required HTTP 401");
    }
    if (index + 1 < attempts) await pause();
  }
  throw new Error("Owned-canary denial never returned exact HTTP 401 after bounded retries");
}

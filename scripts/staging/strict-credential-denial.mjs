/**
 * A newly published workers.dev script may produce a transient edge-level 404
 * or 503 while the route propagates. Those are NOT a pass for authentication.
 * Require an exact Worker-issued 401 before certifying forged-token rejection.
 */
export async function requireWorkerCredentialDenial(
  probe,
  { attempts = 8, pause = () => new Promise((resolve) => setTimeout(resolve, 750)) } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 12)
    throw new Error("Invalid bounded authentication probe attempts");
  let response;
  for (let attempt = 0; attempt < attempts; attempt++) {
    response = await probe();
    if (response?.status === 401) return;
    // 200/other statuses may NEVER be silently retried into a pass.
    if (![404, 503].includes(response?.status)) break;
    if (attempt + 1 < attempts) await pause();
  }
  throw new Error("A forged credential must receive exact Worker-issued 401");
}

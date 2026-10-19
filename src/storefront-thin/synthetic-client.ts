/** Called only AFTER bearer authentication, on two allowlisted artificial D1s.
 * Model many independent load clients without disabling the 180/min policy.
 * Never interpret this header in a public or production application.
 */
export function syntheticClient(
  request: Request,
  env: {
    COVE_SSR_STAGING?: string;
    COVE_PERF_DATABASE_ID?: string;
  },
) {
  const client = request.headers.get("x-cove-perf-client");
  if (client === null) return request;
  if (
    env.COVE_SSR_STAGING !== "1" ||
    !["cc842ee5-c526-431e-96ee-5e093fb45e6d", "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3"].includes(
      env.COVE_PERF_DATABASE_ID || "",
    ) ||
    !/^\d{1,5}$/.test(client) ||
    Number(client) > 65535
  )
    throw new Error("Synthetic identity outside isolated benchmark");
  const headers = new Headers(request.headers);
  headers.set("cf-connecting-ip", `198.18.${Number(client) >>> 8}.${Number(client) & 255}`);
  headers.delete("x-cove-client-ip");
  headers.delete("x-cove-perf-client");
  return new Request(request, { headers });
}

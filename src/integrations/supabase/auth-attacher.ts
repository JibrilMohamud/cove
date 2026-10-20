import { createMiddleware } from "@tanstack/react-start";

export const attachSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    // A server function's client phase also runs when an SSR loader calls it.
    // Browser storage cannot supply that request's server-side identity;
    // server auth uses the incoming request and its validation middleware.
    if (typeof window === "undefined") return next({ headers: {} });
    // Keep the browser SDK outside both the SSR import graph and execution.
    const { getSupabaseClient } = await import("./client");
    const client = getSupabaseClient();
    if (!client) return next({ headers: {} });
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    return next({ headers: token ? { Authorization: `Bearer ${token}` } : {} });
  },
);

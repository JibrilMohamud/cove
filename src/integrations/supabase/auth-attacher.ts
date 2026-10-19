import { createMiddleware } from "@tanstack/react-start";

export const attachSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    // This middleware runs in the browser; server-side SSR must not eagerly
    // initialize Supabase session, websocket and HTTP client dependencies.
    // Await the client *before* every server-function request so bearer token
    // attachment and fail-closed authentication semantics are unchanged.
    const { getSupabaseClient } = await import("./client");
    const client = getSupabaseClient();
    if (!client) return next({ headers: {} });
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    return next({ headers: token ? { Authorization: `Bearer ${token}` } : {} });
  },
);

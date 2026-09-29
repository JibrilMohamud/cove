import { createMiddleware } from "@tanstack/react-start";
import { getSupabaseClient } from "./client";

export const attachSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    const client = getSupabaseClient();
    if (!client) return next({ headers: {} });
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    return next({ headers: token ? { Authorization: `Bearer ${token}` } : {} });
  },
);

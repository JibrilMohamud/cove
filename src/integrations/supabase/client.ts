// Supabase is optional for public browsing and reading. When it is not configured,
// the app falls back to Gutendex and simply disables account-backed features.
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
}

function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
    );

    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));

    if (
      isNewSupabaseApiKey(supabaseKey) &&
      headers.get("Authorization") === `Bearer ${supabaseKey}`
    ) {
      headers.delete("Authorization");
    }

    headers.set("apikey", supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

const processEnv =
  typeof process !== "undefined" && process.env ? process.env : ({} as Record<string, string>);

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || processEnv.SUPABASE_URL || "";
export const SUPABASE_PUBLISHABLE_KEY =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || processEnv.SUPABASE_PUBLISHABLE_KEY || "";

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);

type SupabaseClient = ReturnType<typeof createClient<Database>>;
let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  if (client) return client;

  client = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { fetch: createSupabaseFetch(SUPABASE_PUBLISHABLE_KEY) },
    auth: {
      storage: typeof window !== "undefined" ? localStorage : undefined,
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  return client;
}

// Kept for existing signed-in call sites. Public code should prefer getSupabaseClient().
export const supabase = new Proxy({} as SupabaseClient, {
  get(_, prop, receiver) {
    const active = getSupabaseClient();
    if (!active) {
      throw new Error(
        "Supabase is not configured. Public browsing remains available, but account features require Supabase environment variables.",
      );
    }
    return Reflect.get(active, prop, receiver);
  },
});

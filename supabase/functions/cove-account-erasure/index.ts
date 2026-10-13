import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { handleErasure } from "./handler.ts";
import trustKey from "./trust-key.json" with { type: "json" };

Deno.serve((request: Request) =>
  handleErasure(request, trustKey, async (providerId) => {
    const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const key = secretKeys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!key) throw new Error("identity_configuration_missing");
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    }).auth.admin;
    const found = await admin.getUserById(providerId);
    if (found.error?.status === 404 && found.error.code === "user_not_found") return true;
    if (found.error || !found.data.user) throw new Error("identity_lookup_failed");
    // Prevent new sessions while erasure completes. Existing Cove sessions are fenced in D1.
    const banned = await admin.updateUserById(providerId, { ban_duration: "876000h" });
    if (banned.error) throw new Error("identity_deactivation_failed");
    const deleted = await admin.deleteUser(providerId, false);
    if (deleted.error) throw new Error("identity_delete_failed");
    const check = await admin.getUserById(providerId);
    return check.error?.status === 404 && check.error.code === "user_not_found";
  }),
);

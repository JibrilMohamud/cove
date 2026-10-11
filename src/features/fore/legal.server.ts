import { z } from "zod";
import type { CoveEnv } from "./api.server";
import { ApiError, json, now, rateLimit, readBody } from "./service";

// Public privacy requests deliberately do not require a Cove account.
// Messages go into a durable D1 inbox. Never echo their contents to the public.
export async function handleLegalContact(
  request: Request,
  env: CoveEnv,
  path: string,
): Promise<Response | null> {
  if (path !== "/legal/contact") return null;
  if (request.method !== "POST") throw new ApiError(405, "Send a POST request.");
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new ApiError(403, "Please submit this request from Cove's website.");
  }
  const input = z.object({
    category: z.enum([
      "privacy-access", "privacy-delete", "privacy-correction",
      "privacy-choice", "privacy-other", "terms", "other",
    ]),
    email: z.string().trim().email().max(254).transform((x) => x.toLowerCase()),
    message: z.string().trim().min(15).max(4000),
    website: z.string().max(100).optional().default(""),
  }).parse(await readBody(request, 6000));
  // Basic bot trap: do not store or acknowledge a bogus account request.
  if (input.website) return json({ received: true });
  const sourceIp = (request.headers.get("cf-connecting-ip") || request.headers.get("x-cove-client-ip") || "unknown").slice(0, 128);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sourceIp));
  const bucket = Array.from(new Uint8Array(hash)).slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
  await rateLimit(env, "legal:contact:" + bucket, 5);
  if (!env.DB) throw new ApiError(503, "Privacy requests cannot be saved right now.");
  const id = "legal_" + crypto.randomUUID();
  const at = now();
  await env.DB.prepare(
    "INSERT INTO legal_contact_requests(id,category,email,message,state,created_at,updated_at) VALUES(?,?,?,?,'open',?,?)",
  ).bind(id, input.category, input.email, input.message, at, at).run();
  return json({
    received: true,
    reference: id,
    message: "Your request has been recorded. Keep this reference number for your records.",
  }, 201);
}

import { z } from "zod";
import type { CoveEnv } from "./api.server";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const now = () => new Date().toISOString();
export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
export const bookIdSchema = z.string().regex(/^(?:[1-9][0-9]{0,8}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,100}|(?:upload|fore)_[a-f0-9-]{36}|prd_[a-f0-9]{32})$/);
export async function readBody(request: Request, max = 100_000) {
  if (Number(request.headers.get("content-length") || 0) > max)
    throw new ApiError(413, "This request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "A request body is required.");
  let len = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      len += value.length;
      if (len > max) {
        await reader.cancel();
        throw new ApiError(413, "This request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(len);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "Please send valid JSON.");
  }
}
export async function rateLimit(env: CoveEnv, key: string, limit: number) {
  const minute = Math.floor(Date.now() / 60000);
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start=excluded.window_start THEN count+1 ELSE 1 END,window_start=excluded.window_start RETURNING count",
  )
    .bind(key, minute)
    .first<any>();
  if (row.count > limit) throw new ApiError(429, "Please wait a minute before trying again.");
}
export function requireIdentity(userId?: string | null) {
  if (!userId) throw new ApiError(401, "Sign in to save your reading life.");
  return userId;
}


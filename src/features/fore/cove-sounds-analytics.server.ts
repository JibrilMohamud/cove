/* eslint-disable prettier/prettier -- Schema and safety gates are colocated for reviewer audit; normalize after canary. */
import type { CoveEnv } from "./api.server";
import { stationBySlug } from "./cove-sounds-stations";
import { ApiError, json } from "./service";

const EVENTS = new Set([
  "station_view", "music_open", "track_select", "book_open",
  "book_preview", "reading_intent", "share", "shelf_open", "shelf_create",
  "purchase_intent",
]);
/** Intent / UI funnel analytics, not verified commerce or reading completion.
 * Aggregate-only; no IP, user ID, order ID, product ID, URL, cookies or query.
 * The optional Analytics Engine sink MUST NOT fallback to primary D1.
 */
export async function handleSoundsAnalytics(
  request: Request, env: CoveEnv, path: string, territory: string,
): Promise<Response | null> {
  if (path !== "/sounds/events") return null;
  if (request.method !== "POST") throw new ApiError(405, "Method not allowed");
  if (Number(request.headers.get("content-length") || "0") > 1024)
    throw new ApiError(413, "Event too large");
  const raw = await request.text();
  if (raw.length > 1024) throw new ApiError(413, "Event too large");
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw new ApiError(400, "Invalid event"); }
  if (!input || typeof input !== "object") throw new ApiError(400, "Invalid event");
  const { event, station, recording } = input as Record<string, unknown>;
  if (typeof event !== "string" || !EVENTS.has(event) ||
      typeof station !== "string" || !stationBySlug(station) ||
      (recording !== undefined && (typeof recording !== "string" ||
        !/^(?:cm_[0-9]{1,15}|ex_[0-9a-f-]{36})$/.test(recording))))
    throw new ApiError(400, "Invalid event");
  if (typeof env.SOUNDS_ANALYTICS?.writeDataPoint !== "function")
    return json({ accepted: false, reason: "metrics_disabled" }, 202);
  try {
    env.SOUNDS_ANALYTICS.writeDataPoint({
      blobs: ["cove-sounds-client-intent-v1", station, event, recording || "none", territory],
      doubles: [1],
      indexes: [station],
    });
  } catch {
    // Telemetry never blocks readers or amplifies a D1 outage.
    return json({ accepted: false, reason: "metrics_unavailable" }, 202);
  }
  return json({ accepted: true }, 202);
}
export function isSoundsAnalyticsAck(request: Request, response: Response) {
  return request.method === "POST" &&
    new URL(request.url).pathname === "/api/fore/sounds/events" &&
    response.status === 202;
}

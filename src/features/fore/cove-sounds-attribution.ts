/* eslint-disable prettier/prettier -- Local-only privacy expiry and funnel dedupe intentionally colocated for audit. */
import { stationBySlug } from "./cove-sounds-stations";

const KEY = "cove:sounds:session-attribution:v1";
const MAX_AGE = 2 * 60 * 60_000;
type Signal = "reading_started" | "purchase_observed";
type Session = {
  station: string;
  recordedAt: number;
  recording?: string;
  sent: string[];
};
function allowed() {
  return typeof window !== "undefined" && navigator.doNotTrack !== "1" &&
    !(navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl;
}
function load(): Session | null {
  if (!allowed()) return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    const doc = raw ? JSON.parse(raw) as Session : null;
    if (!doc || !stationBySlug(doc.station) ||
        !Number.isSafeInteger(doc.recordedAt) || Date.now() - doc.recordedAt > MAX_AGE ||
        doc.recordedAt > Date.now() + 5000 || !Array.isArray(doc.sent)) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    return doc;
  } catch { return null; }
}
/** Browser-tab only, two hours; never store product, account or order IDs. */
export function rememberSoundsBookReferral(station: string, recording?: string) {
  if (!allowed() || !stationBySlug(station)) return;
  const doc: Session = { station, recordedAt: Date.now(), sent: [] };
  if (recording && /^(?:cm_[0-9]{1,15}|ex_[0-9a-f-]{36})$/.test(recording))
    doc.recording = recording;
  try { sessionStorage.setItem(KEY, JSON.stringify(doc)); } catch { /* Browser privacy storage is best-effort. */ }
}
/** Client-observed, deduplicated signals. The server never receives referents
 * or personal identifiers; purchase_observed is NOT signed-webhook proof. */
export function reportSoundsConversion(event: Signal, localRef: string) {
  const doc = load();
  if (!doc || typeof localRef !== "string" || localRef.length > 160) return;
  const discriminator = event + ":" + localRef;
  if (doc.sent.includes(discriminator)) return;
  doc.sent = [...doc.sent.slice(-15), discriminator];
  try { sessionStorage.setItem(KEY, JSON.stringify(doc)); } catch { /* Browser privacy storage is best-effort. */ }
  void fetch("/api/fore/sounds/events", {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      station: doc.station, event,
      ...(doc.recording ? { recording: doc.recording } : {}),
    }),
    keepalive: true,
  }).catch(() => {});
}

/** A checkout referral is a privacy-aware, self-declared session association.
 * Only server-owned paid-order state can later establish a verified purchase.
 * No account, book, or order identifiers are placed in browser attribution. */
export function soundsCheckoutReferral():
  { soundsStation: string; soundsRecording?: string } | null {
  const referral = load();
  if (!referral) return null;
  return {
    soundsStation: referral.station,
    ...(referral.recording ? { soundsRecording: referral.recording } : {}),
  };
}

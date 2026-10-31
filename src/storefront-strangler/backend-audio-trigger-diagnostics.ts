/**
 * Audio scheduler diagnostics are nonauthoritative telemetry, not customer
 * state. They MUST NOT acquire a canonical D1 write capability or advance
 * leases/entitlements on either a successful trigger or a timeout.
 *
 * The dedicated Analytics Engine dataset stores bounded operational fields.
 * A provider outage leaves a redacted Worker log; it never falls back to D1.
 */
export type AudioDiagnosticKind =
  | "audio_trigger_last_error"
  | "audio_trigger_last_success"
  | "audio_trigger_last_timeout";

export type BackendDiagnosticsEnv = {
  BACKEND_DIAGNOSTICS?: {
    writeDataPoint(point: {
      indexes: string[];
      blobs: string[];
      doubles: number[];
    }): void;
  };
};

export function reportAudioTriggerDiagnostic(
  env: BackendDiagnosticsEnv,
  kind: AudioDiagnosticKind,
  value: Record<string, unknown>,
): void {
  const timestamp = Date.now();
  const at = new Date(timestamp).toISOString();
  // Never persist the Vercel response body: it can contain tokens, account
  // identifiers or internal tracebacks. No URL query string is recorded.
  const rawPath = typeof value.path === "string" ? value.path : "";
  const path = /^\/api\/fore\/internal\/ingestion\/audio-[a-z-]{1,40}$/.test(rawPath)
    ? rawPath
    : "invalid_path";
  const status =
    typeof value.status === "number" && Number.isSafeInteger(value.status) &&
    value.status >= 100 && value.status <= 599
      ? value.status
      : 0;
  const disposition = value.disposition === "in-flight" ? "in-flight" : "completed";
  const event = {
    event: "cove_audio_trigger_diagnostic",
    kind,
    path,
    status,
    disposition,
    at,
  };
  console.info(JSON.stringify(event));

  try {
    env.BACKEND_DIAGNOSTICS?.writeDataPoint({
      indexes: [kind],
      blobs: [path, disposition],
      doubles: [status, timestamp],
    });
  } catch {
    // Logs are intentionally independent of the optional metrics sink.
    console.warn("cove_audio_trigger_metrics_unavailable");
  }
}

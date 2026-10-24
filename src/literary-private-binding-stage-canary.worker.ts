import type { CoveEnv } from "./features/fore/api.server";

type StageEnv = Pick<CoveEnv, "DB" | "BUCKET"> & {
  CONTENT_DB: CoveEnv["DB"];
  LITERARY_PUBLISHER: { fetch(request: Request): Promise<Response> };
  FORE_LITERARY_INFERENCE_PUBLISH_TOKEN?: string;
  FORE_LITERARY_INFERENCE_BACKEND_TOKEN?: string;
  FORE_LITERARY_QA_ENABLED?: string;
};
const sha = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const qaId = "qa_literary";

export async function runPrivateLiteraryBindingCanary(env: StageEnv) {
  if (env.FORE_LITERARY_QA_ENABLED !== "1") return { skipped: "disabled" };
  const token = env.FORE_LITERARY_INFERENCE_PUBLISH_TOKEN || "";
  const other = env.FORE_LITERARY_INFERENCE_BACKEND_TOKEN || "";
  if (token.length < 40 || other.length < 40 || token === other)
    throw Error("staged_private_publisher_secrets_missing");
  const previous = await env.CONTENT_DB.prepare(
    "SELECT result FROM literary_qa_private_pub_receipts WHERE id=1",
  ).first<{ result: string }>();
  if (previous?.result === "passed") return { passed: "already_certified" };
  if (!env.BUCKET) throw Error("staged_private_r2_missing");
  const inference = await env.CONTENT_DB.prepare(
    "SELECT id,prepare_job_id,result_key,result_sha256 FROM literary_inference_jobs" +
      " WHERE product_id=? AND status='done' LIMIT 1",
  )
    .bind(qaId)
    .first<{
      id: string;
      prepare_job_id: string;
      result_key: string;
      result_sha256: string;
    }>();
  if (!inference) throw Error("synthetic_inference_not_ready");
  const prepared = await env.CONTENT_DB.prepare(
    "SELECT result_key,result_sha256 FROM literary_prepare_jobs WHERE id=? AND status='done'",
  )
    .bind(inference.prepare_job_id)
    .first<{ result_key: string; result_sha256: string }>();
  if (!prepared) throw Error("synthetic_preparation_not_ready");
  // API-imported QA objects may lack Workers R2 metadata. Reapply it through
  // the real R2 binding, checking bytes against the durable secondary receipt.
  for (const artifact of [prepared, inference]) {
    const object = await env.BUCKET.get(artifact.result_key);
    if (!object) throw Error("staged_artifact_missing");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if ((await sha(bytes)) !== artifact.result_sha256)
      throw Error("staged_artifact_hash_mismatch");
    await env.BUCKET.put(artifact.result_key, bytes, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { sha256: artifact.result_sha256 },
    });
  }
  const existing = await env.DB.prepare(
    "SELECT revision,status FROM literary_profiles WHERE product_id=?",
  )
    .bind(qaId)
    .first<{ revision: number; status: string }>();
  if (existing?.revision === 1 && existing.status === "analyzed") {
    await env.DB.prepare(
      "UPDATE literary_profiles SET revision=0,status='provisional'," +
        "coverage='metadata',profile_json='{}' WHERE product_id=? AND revision=1" +
        " AND status='analyzed'",
    )
      .bind(qaId)
      .run();
  } else if (existing?.revision !== 0 || existing.status !== "provisional") {
    throw Error("unexpected_staging_profile_state");
  }
  const owner = await env.DB.prepare(
    "SELECT value FROM cove_runtime_config WHERE key='literary_processing_owner'",
  ).first<{ value: string }>();
  if (owner?.value !== "isolated") throw Error("staging_owner_not_isolated");
  const req = new Request("https://literary-publisher.internal/v1/operator/publish", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cove-literary-publish-token": token,
      "x-cove-literary-backend-token": other,
    },
    body: JSON.stringify({ jobId: inference.id }),
  });
  const response = await env.LITERARY_PUBLISHER.fetch(req);
  if (response.status !== 200) throw Error("private_publisher_http_" + response.status);
  const result = (await response.json()) as { published?: string };
  if (result?.published !== qaId) throw Error("private_publisher_no_canonical_ack");
  const canonical = await env.DB.prepare(
    "SELECT status,revision,coverage FROM literary_profiles WHERE product_id=?",
  )
    .bind(qaId)
    .first<{ status: string; revision: number; coverage: string }>();
  if (
    canonical?.status !== "analyzed" ||
    canonical.revision !== 1 ||
    canonical.coverage !== "isolated_samples"
  )
    throw Error("private_publisher_canonical_commit_mismatch");
  await env.CONTENT_DB.prepare(
    "INSERT INTO literary_qa_private_pub_receipts(id,result,observed_at) VALUES(1,'passed',?)" +
      " ON CONFLICT(id) DO UPDATE SET result=excluded.result,observed_at=excluded.observed_at",
  )
    .bind(new Date().toISOString())
    .run();
  return { passed: "private_binding_and_real_r2_sha_validated", revision: 1 };
}
export default {
  async scheduled(
    _controller: { cron: string },
    env: StageEnv,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ) {
    ctx.waitUntil(
      runPrivateLiteraryBindingCanary(env).catch((error) => {
        console.error("literary_private_stage_canary_failure", String(error).slice(0,160));
        throw error;
      }),
    );
  },
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
};

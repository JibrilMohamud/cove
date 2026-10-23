import { unbiasedCryptoInt } from "./unbiased-random";
import {
  runIsolatedLiteraryPreparationTick,
  type PreparationEnv,
} from "./literary-preparation-domain.server";

type Message = {
  body: unknown;
  attempts: number;
  ack(): void;
  retry(options: { delaySeconds: number }): void;
};
export type PreparationBatch = { messages: Message[] };

/** D1 leases are the durable idempotency fence; Queues carries only wakeups.
 * No source URL, credentials, grants or document bytes in a message.
 * Configure max_concurrency=1 and max_batch_size=1. */
export async function consumePreparationQueue(
  batch: PreparationBatch,
  env: PreparationEnv,
  run = runIsolatedLiteraryPreparationTick,
) {
  if (
    env.FORE_CONTENT_PROCESSOR_ENABLED !== "1" ||
    env.FORE_CONTENT_PREPARE_ENABLED !== "1" ||
    env.FORE_CONTENT_PROCESSOR_ROLE !== "literary-prepare"
  )
    throw Error("preparation_queue_disabled");
  for (const message of batch.messages) {
    const body = message.body as { schema?: unknown; jobId?: unknown } | null;
    if (
      !body ||
      body.schema !== "cove.literary.prepare.v1" ||
      typeof body.jobId !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.jobId)
    )
      throw Error("invalid_preparation_queue_message");
    try {
      const result = await run(env, body.jobId);
      const delay = "retryAfterSeconds" in result ? result.retryAfterSeconds : null;
      if (delay) message.retry({ delaySeconds: delay });
      else message.ack();
    } catch {
      const jitter = unbiasedCryptoInt(30);
      message.retry({
        delaySeconds: Math.min(3600, 30 * 2 ** Math.min(6, message.attempts) + jitter),
      });
    }
  }
}

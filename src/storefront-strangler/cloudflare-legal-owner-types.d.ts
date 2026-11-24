declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown> {
    constructor(ctx: unknown, env: Env);
    readonly env: Env;
    readonly ctx: { waitUntil(promise: Promise<unknown>): void };
  }
  export class DurableObject<Env = unknown> {
    constructor(ctx: { storage: { sql: unknown } }, env: Env);
    readonly ctx: { storage: { sql: unknown } };
    readonly env: Env;
  }
}

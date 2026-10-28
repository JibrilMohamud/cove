declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    constructor(ctx: { storage: { sql: unknown } }, env: Env);
    readonly ctx: { storage: { sql: unknown } };
    readonly env: Env;
  }
}

/**
 * Narrow runtime contract for Cloudflare's DurableObject base class.
 * Cove's current TS config lacks the Cloudflare Workers ambient types; this
 * declaration covers only this private stage owner's ctx/env access.
 * Workerd supplies the actual class at runtime via cloudflare:workers.
 * Keep aligned with https://developers.cloudflare.com/durable-objects/api/state/
 */
declare module "cloudflare:workers" {
  export class DurableObject<E = unknown> {
    protected readonly ctx: { storage: { sql: unknown } };
    protected readonly env: E;
    constructor(ctx: { storage: { sql: unknown } }, env: E);
  }
}

import { WorkerEntrypoint } from "cloudflare:workers";
import {
  attestDisabledOwnerFromBackend,
  type DisabledOwnerCallerEnv,
} from "./production-disabled-owner-attestation";

/** A service-binding-only diagnostic using the backend's actual private
 * credential and DO binding. It exposes no credential, SQL, or legal command.
 * The public HTTP handler cannot invoke this named entrypoint's RPC method.
 */
export class BackendOwnerAttestation extends WorkerEntrypoint<DisabledOwnerCallerEnv> {
  async fetch() {
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  }

  async attestDisabledOwner() {
    return attestDisabledOwnerFromBackend(this.env);
  }
}

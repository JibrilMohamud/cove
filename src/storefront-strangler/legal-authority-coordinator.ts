/* eslint-disable prettier/prettier -- Rights mutation ordering is a security boundary. */
import { validateAuthorityCommand, type AuthorityCommand } from "./legal-authority-core";

type PrivateAuthorityPort={ fetch(request:Request):Promise<Response> };
function authorizedRequest(secret:string,path:string,body:Record<string,unknown>) {
  if(!/^[a-f0-9]{64}$/.test(secret)) throw Error("invalid_private_owner_secret");
  return new Request("https://legal-authority.internal"+path,{
    method:"POST", headers:{"authorization":"Bearer "+secret,"content-type":"application/json"},
    body:JSON.stringify(body)
  });
}
async function confirmed(
  authority:PrivateAuthorityPort,secret:string,
  path:string,command:AuthorityCommand,
  extra:Record<string,unknown>={}
) {
  const response=await authority.fetch(authorizedRequest(secret,path,{...command,...extra}));
  if(response.status!==200) throw Error("authority_fence_unavailable");
  const ack=await response.json() as {
    applied?:boolean;state?:{allowed?:boolean;revision?:number|null};
  };
  // The owner must have accepted this exact revision, not merely responded
  // 2xx with an older denial/allowance. For denial fail closed regardless.
  if(!ack||ack.applied!==true||ack.state?.revision!==command.revision ||
      ack.state.allowed!==(command.action==="allow"))
    throw Error("authority_fence_unconfirmed");
}

/** The durable denial is acknowledged BEFORE any primary legal mutation.
 * If the canonical mutation fails, the denial remains: retry is conservative.
 * This helper MUST guard EVERY legal writer before production owner cutover. */
export async function denyBeforePrimaryMutation<T>(
  authority:PrivateAuthorityPort, secret:string, input:unknown,
  mutatePrimary:()=>Promise<T>
):Promise<T> {
  const command=validateAuthorityCommand(input);
  if(command.action!=="deny") throw Error("denial_required");
  await confirmed(authority,secret,"/deny",command);
  return mutatePrimary();
}

/** Positive rights proofs commit on primary FIRST. Only afterwards may an
 * independently checked primary offer/grant be published to the authority.
 * No optimistic allowance is returned on authority failure. */
export async function publishAfterPrimaryApproval<T>(
  authority:PrivateAuthorityPort,secret:string,input:unknown,
  currency:string,commitVerifiedPrimary:()=>Promise<T>
):Promise<T> {
  const command=validateAuthorityCommand(input);
  if(command.action!=="allow"||!/^[A-Z]{3}$/.test(currency))
    throw Error("approval_requires_market");
  const output=await commitVerifiedPrimary();
  await confirmed(authority,secret,"/publish-allow",command,{currency});
  return output;
}

/**
 * Preferred writer path: the strongly consistent owner allocates the legal
 * epoch itself and durably records denial BEFORE primary D1 can mutate.
 * Each canonical writer must supply a stable idempotency key from its own
 * source event. Old event counters do NOT authorize a new global revision.
 */
export async function denyWithOwnedSourceEpoch<T>(
  authority:PrivateAuthorityPort,secret:string,
  operation:{sourceId:string;territory:string;operationId:string},
  mutatePrimary:(ownerRevision:number)=>Promise<T>
):Promise<T>{
  validateAuthorityCommand({
    sourceId:operation.sourceId,territory:operation.territory,
    revision:1,action:"deny"
  });
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(operation.operationId))
    throw Error("denial_operation_invalid");
  const response=await authority.fetch(
    authorizedRequest(secret,"/deny-next",operation)
  );
  if(response.status!==200) throw Error("authority_fence_unavailable");
  const receipt=await response.json() as {
    applied?:unknown;revision?:unknown;state?:{allowed?:unknown;revision?:unknown};
  };
  if(receipt?.applied!==true||!Number.isSafeInteger(receipt.revision)||
      (receipt.revision as number)<=0||receipt.state?.allowed!==false||
      receipt.state?.revision!==(receipt.revision as number))
    throw Error("authority_fence_unconfirmed");
  return mutatePrimary(receipt.revision as number);
}

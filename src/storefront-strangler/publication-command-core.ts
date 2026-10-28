/* eslint-disable prettier/prettier -- Durable per-product command holds must precede canonical publication writes. */
import type {AuthoritySql} from "./legal-authority-core";
import {denyCommercialProduct,commercialProductId,captureCommercialEpoch} from "./commercial-legal-core";

export type PublicationCommandIdentity={
  operationId:string;productId:string;commandSha256:string;
};
type CommandRow={operation_id:string;product_id:string;command_sha256:string;
  epoch:number;state:"pending"|"committed";result_json:string|null;published_epoch:number|null};
function validate(raw:PublicationCommandIdentity) {
  if(!raw||typeof raw.operationId!=="string"||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(raw.operationId)||
    !commercialProductId.test(raw.productId)||raw.productId.startsWith("prd_gutenberg_")||
    !/^[a-f0-9]{64}$/.test(raw.commandSha256))throw Error("invalid_publication_command_identity");
}
export function readPublicationCommand(sql:AuthoritySql,operationId:string) {
  return sql.exec<CommandRow>("SELECT * FROM cove_publication_commands WHERE operation_id=?",
    operationId).toArray()[0]??null;
}
/** Execute inside transactionSync. Nothing is allowed to publish until a
 * matching command finishes. A failed/interrupted primary command retains
 * its durable denial and cannot be stolen by a different operation. */
export function beginPublicationCommand(sql:AuthoritySql,input:PublicationCommandIdentity) {
  validate(input);
  const old=readPublicationCommand(sql,input.operationId);
  if(old) {
    if(old.product_id!==input.productId||old.command_sha256!==input.commandSha256)
      throw Error("publication_operation_scope_collision");
    if(old.state==="pending"&&captureCommercialEpoch(sql,{productId:input.productId})!==old.epoch)
      throw Error("publication_command_superseded_by_withdrawal");
    if(old.state==="committed") {
      const state=sql.exec<{epoch:number;verdict:string}>(
        "SELECT epoch,verdict FROM cove_commercial_authority WHERE product_id=?",input.productId).toArray()[0];
      const continuable=state&&(old.published_epoch!==null?
        state.epoch===old.published_epoch&&state.verdict==="allow":
        state.epoch===old.epoch&&state.verdict==="deny"||
        state.epoch===old.epoch+1&&state.verdict==="allow");
      if(!continuable)throw Error("publication_command_superseded_by_withdrawal");
    }
    return old;
  }
  if(sql.exec("SELECT 1 pending FROM cove_publication_commands WHERE product_id=? AND state='pending' LIMIT 1",
    input.productId).toArray().length)throw Error("publication_product_command_in_progress");
  // This is an edit hold, not a terminal withdrawal of the legal evidence.
  // Fresh canonical verification is still mandatory after the hold ends.
  const denied=denyCommercialProduct(sql,{
    productId:input.productId,operationId:"retail:publication:"+input.operationId
  });
  if(!denied.applied)throw Error("publication_denial_not_acknowledged");
  sql.exec("INSERT INTO cove_publication_commands(operation_id,product_id,command_sha256,epoch,state) VALUES(?,?,?,?,'pending')",
    input.operationId,input.productId,input.commandSha256,denied.epoch);
  return readPublicationCommand(sql,input.operationId)!;
}
export function markPublicationPublished(sql:AuthoritySql,input:PublicationCommandIdentity,epoch:number) {
  validate(input);
  const row=readPublicationCommand(sql,input.operationId);
  const state=sql.exec<{epoch:number;verdict:string}>(
    "SELECT epoch,verdict FROM cove_commercial_authority WHERE product_id=?",input.productId).toArray()[0];
  if(!row||row.state!=="committed"||row.product_id!==input.productId||
    row.command_sha256!==input.commandSha256||!Number.isSafeInteger(epoch)||
    state?.epoch!==epoch||state.verdict!=="allow"||epoch!==row.epoch+1)
    throw Error("publication_positive_epoch_not_owned");
  sql.exec("UPDATE cove_publication_commands SET published_epoch=? WHERE operation_id=?",epoch,input.operationId);
}
/** A canonical completion marker is verified independently BEFORE this
 * transaction. Completion releases the hold but NEVER publishes allowance.
 * A separate current-primary legal/offer verification does that afterwards. */
export function commitPublicationCommand(
  sql:AuthoritySql,input:PublicationCommandIdentity,result:unknown
) {
  validate(input);
  const row=readPublicationCommand(sql,input.operationId);
  if(!row||row.product_id!==input.productId||row.command_sha256!==input.commandSha256)
    throw Error("publication_command_not_owned");
  if(row.state==="committed")return row;
  if(captureCommercialEpoch(sql,{productId:input.productId})!==row.epoch)
    throw Error("publication_command_superseded_by_withdrawal");
  const encoded=JSON.stringify(result);
  if(!encoded||encoded.length>4096)throw Error("publication_command_result_invalid");
  sql.exec("UPDATE cove_publication_commands SET state='committed',result_json=? WHERE operation_id=? AND state='pending'",
    encoded,input.operationId);
  return readPublicationCommand(sql,input.operationId)!;
}

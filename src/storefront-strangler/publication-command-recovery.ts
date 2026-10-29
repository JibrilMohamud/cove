/* eslint-disable prettier/prettier -- Recovery must re-enter the original typed owner handlers, never raw D1 writers. */
import type {AuthoritySql} from "./legal-authority-core";

export const PUBLICATION_RECOVERY_LIMIT=25;
/** Scan a rotating bounded page so one permanently blocked command cannot
 * starve later repairs. Old journal rows without a recovery envelope stay
 * denied. The original handlers reverify the immutable manifest, completion
 * marker, staff permissions and withdrawal epoch before any positive result. */
export async function recoverPublicationCommands(sql:AuthoritySql,
  dispatch:(route:string,body:Record<string,unknown>)=>Promise<Response>) {
  const after=sql.exec<{after_operation_id:string}>(
    "SELECT after_operation_id FROM cove_publication_recovery_scan WHERE id=1").toArray()[0]?.after_operation_id||"";
  const read=(cursor:string)=>sql.exec<{operation_id:string;recovery_json:string}>(
    "SELECT operation_id,recovery_json FROM cove_publication_commands WHERE recovery_json IS NOT NULL AND (state='pending' OR published_epoch IS NULL) AND operation_id>? ORDER BY operation_id LIMIT ?",
    cursor,PUBLICATION_RECOVERY_LIMIT).toArray();
  let rows=read(after);
  if(!rows.length&&after)rows=read("");
  let recovered=0;
  for(const row of rows) {
    try {
      const recorded=JSON.parse(row.recovery_json) as {route?:unknown;body?:unknown};
      if(!recorded||!["/publication/activate-version","/publication/open-preorder","/publication/materialize-submission"].includes(String(recorded.route))||
        !recorded.body||typeof recorded.body!=="object"||Array.isArray(recorded.body)||
        (recorded.body as Record<string,unknown>).operationId!==row.operation_id)
        continue;
      const response=await dispatch(String(recorded.route),recorded.body as Record<string,unknown>);
      // A successful handler must also have committed its positive epoch.
      // Do not count a forged/success-looking response as an actual repair.
      const complete=sql.exec<{state:string;published_epoch:number|null}>(
        "SELECT state,published_epoch FROM cove_publication_commands WHERE operation_id=?",row.operation_id).toArray()[0];
      if(response.status===200&&complete?.state==="committed"&&
        Number.isSafeInteger(complete.published_epoch)&&(Number(complete.published_epoch)>0||
          recorded.route==="/publication/materialize-submission"&&complete.published_epoch===0))recovered++;
    } catch { /* Keep the durable denial; continue other independent repairs. */ }
  }
  sql.exec("UPDATE cove_publication_recovery_scan SET after_operation_id=? WHERE id=1",
    rows.at(-1)?.operation_id||"");
  return {checked:rows.length,recovered,blocked:rows.length-recovered};
}

/** A scheduled task that explicitly reports failure must never be acknowledged
 * as successful merely because its Promise resolved. */
export function assertCronResult<T>(result:T):T {
  if(result!==null&&typeof result==="object"&&"ok" in result&&
     (result as {ok?:unknown}).ok===false)
    throw Error("cove_scheduled_operation_reported_failure");
  return result;
}

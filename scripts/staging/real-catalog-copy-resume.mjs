/* eslint-disable prettier/prettier -- Independent page readback and restart contract. */
import assert from "node:assert/strict";
import {isDeepStrictEqual} from "node:util";
export async function reconcilePage(expected,{readTarget,write,checkExisting}){
  assert.ok(Array.isArray(expected)&&expected.length>0);
  if(checkExisting){
    const existing=await readTarget();
    if(isDeepStrictEqual(existing,expected))return {verified:existing,reused:true};
  }
  await write(expected);
  const actual=await readTarget();
  assert.deepEqual(actual,expected,"Independent stage-read page parity failed");
  return {verified:actual,reused:false};
}

/* eslint-disable prettier/prettier -- TCP recovery counters and privacy-preserving parsing remain explicit. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const run=promisify(execFile);
const number=(text,re)=> {
  const match=re.exec(text);
  return match ? Number(match[1]):null;
};

/**
 * Parse Linux 'ss -tin' without persisting IP addresses, hostnames, process
 * IDs, HTTP headers, bearer tokens or payload. The second retrans figure is
 * cumulative on a socket, distinct from the current unacknowledged packets.
 */
export function parseKernelSocketEvidence(stdout, activePorts) {
  const ports=new Set(activePorts.filter(Number.isInteger));
  const lines=String(stdout).split(/\r?\n/);
  const counters=[];
  for(let i=0;i<lines.length;i++){
    const header=/^\s*ESTAB\s+\d+\s+\d+\s+\S+:(\d+)\s+\S+:443(?:\s|$)/.exec(lines[i]);
    if(!header) continue;
    const localPort=Number(header[1]);
    if(!ports.has(localPort))continue;
    const state=lines[i+1]||"";
    const retrans=/\bretrans:(\d+)\/(\d+)\b/.exec(state);
    const data={
      localPort,
      tcpRttMs:number(state,/\brtt:([0-9.]+)/),
      tcpRtoMs:number(state,/\brto:([0-9.]+)/),
      retransCurrentlyUnacked:retrans?Number(retrans[1]):null,
      retransCumulative:retrans?Number(retrans[2]):null,
      bytesRetransmitted:number(state,/\bbytes_retrans:([0-9]+)/),
      bytesAcked:number(state,/\bbytes_acked:([0-9]+)/),
      packetsLost:number(state,/\blost:([0-9]+)/)
    };
    counters.push(data);
  }
  return counters;
}

export async function takeAnonymizedTcpSnapshot(sessions) {
  if(process.platform!=="linux")return {available:false,reason:"non-linux"};
  const ports=sessions.map(s=>s.localPort);
  try {
    const {stdout}=await run("ss",["-tin"],{timeout:2500,maxBuffer:2*1024*1024});
    const records=parseKernelSocketEvidence(stdout,ports);
    return {available:true,records:records.map(s=>{
      const session=sessions.find(v=>v.localPort===s.localPort);
      return {sessionId:session?.sessionId ?? null,...s};
    })};
  }catch(e){
    return {available:false,reason:e?.code==="ENOENT"?"ss-not-installed":"kernel-probe-unavailable"};
  }
}
export function compareTcpSnapshots(before,after,slowSessions=[]) {
  const b=new Map((before?.records||[]).map(row=>[row.sessionId,row]));
  const a=new Map((after?.records||[]).map(row=>[row.sessionId,row]));
  return {
    schema:"cove.tcp-h2-path.v1",
    beforeAvailable:before?.available===true,
    afterAvailable:after?.available===true,
    slowSessionEvidence:[...new Set(slowSessions)].slice(0,8).map(sessionId=>{
      const early=b.get(sessionId),late=a.get(sessionId);
      const delta=(key)=>early?.[key]!==null&&late?.[key]!==null&&
        Number.isFinite(early?.[key])&&Number.isFinite(late?.[key])
        ? Math.max(0,late[key]-early[key]):null;
      return {sessionId,
        localPort:late?.localPort ?? early?.localPort ?? null,
        currentRttMs:late?.tcpRttMs ?? null,
        currentRtoMs:late?.tcpRtoMs ?? null,
        retransDelta:delta("retransCumulative"),
        bytesRetransDelta:delta("bytesRetransmitted"),
        currentUnackedRetrans:late?.retransCurrentlyUnacked ?? null,
        available:!!early&&!!late
      };
    }),
    interpretation:"Per-socket cumulative TCP counters only. A positive delta supports packet recovery but does NOT locate the missing segment or prove Cloudflare responsibility."
  };
}
if(process.argv.includes("--self-test")) {
  const sample="State Recv-Q Send-Q Local Address:Port Peer Address:Port\n"+
    "ESTAB 0 0 10.2.3.4:45123 104.16.0.3:443\n"+
    " cubic rto:222 rtt:11.8/4.1 retrans:0/2 bytes_acked:20000 bytes_retrans:1550\n";
  const rows=parseKernelSocketEvidence(sample,[45123]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].retransCumulative,2);
  assert.equal(rows[0].tcpRtoMs,222);
  assert.ok(!JSON.stringify(rows).includes("104.16."));
  const b={available:true,records:[{...rows[0],sessionId:3,retransCumulative:0,bytesRetransmitted:0}]};
  const a={available:true,records:[{...rows[0],sessionId:3}]};
  const delta=compareTcpSnapshots(b,a,[3]).slowSessionEvidence[0];
  assert.equal(delta.retransDelta,2);
  assert.equal(delta.bytesRetransDelta,1550);
  console.log("PASS: anonymized TCP retransmission evidence parser");
}

/* eslint-disable prettier/prettier -- Staff-only release screen will be normalized after rights-flow validation. */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

type ExternalItem = {
  id:string; provider:"fma"|"musopen"; source_page_url:string; title:string;
  status:string; reviewed_at:string|null; created_at:string;
};
type ExternalDetail = {
  record:ExternalItem & {
    performer:string; composer:string; license_code:string; license_url:string;
    license_statement:string; attribution_text:string; provenance_json:string;
    provenance_sha256:string; quality_report_json:string; source_file_sha256:string;
    source_size:number; storage_key:string|null;
  };
  history:{id:string;actor:string;event_type:string;created_at:string}[];
};
type ExternalList = {records:ExternalItem[];counts:{provider:string;status:string;n:number}[]};

type EvidenceLayer = "composition" | "arrangement" | "lyrics" | "performance" | "master";
type EvidenceRecord = { basis?: string; evidenceUrls?: string[] };
type ExternalProvenance = {
  grant?: { evidenceUrl?: string; grantingParty?: string; scope?: string };
  rightsEvidence?: Partial<Record<EvidenceLayer, EvidenceRecord>>;
};
type ExternalQuality = {
  durationSeconds?: number;
  integratedLufs?: number;
  truePeakDbfs?: number;
};

export function SoundtrackExternalReview() {
  const cache=useQueryClient();
  const [selected,setSelected]=useState("");
  const [assessment,setAssessment]=useState("");
  const [checks,setChecks]=useState({license:false,permission:false,listened:false});
  const [reason,setReason]=useState("");
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState("");
  const listing=useQuery({
    queryKey:["soundtracks-external-queue"],
    queryFn:()=>api<ExternalList>("/admin/soundtracks/external"),
    retry:false,enabled:typeof window!=="undefined",
  });
  const detail=useQuery({
    queryKey:["soundtracks-external-detail",selected],
    queryFn:()=>api<ExternalDetail>("/admin/soundtracks/external/"+selected),
    retry:false,enabled:!!selected&&typeof window!=="undefined",
  });
  const row=detail.data?.record;
  const provenance=(()=>{
    try {return row?JSON.parse(row.provenance_json) as ExternalProvenance:null;}
    catch{return null;}
  })();
  const quality=(()=>{
    try {return row?JSON.parse(row.quality_report_json) as ExternalQuality:null;}
    catch{return null;}
  })();
  async function decision(action:"approve"|"revoke"|"reject") {
    if (!selected||busy||!row) return;
    setBusy(true);setNotice("");
    try {
      const payload=action==="approve"?{
        provenanceSha256:row.provenance_sha256,assessment,
        sourceLicenseChecked:checks.license,providerPermissionChecked:checks.permission,
        exactMasterListened:checks.listened,
      }:{reason};
      await api("/admin/soundtracks/external/"+selected+"/"+action,"POST",payload);
      setNotice(row.title+": "+action+" recorded.");
      setSelected("");setAssessment("");setReason("");
      setChecks({license:false,permission:false,listened:false});
      await cache.invalidateQueries({queryKey:["soundtracks-external-queue"]});
    } catch(error) {
      setNotice(error instanceof Error?error.message:"This rights decision could not be saved.");
    } finally {setBusy(false);}
  }
  return (
    <section aria-labelledby="external-rights-title">
      <h2 id="external-rights-title">Provider-delivered masters (FMA and Musopen)</h2>
      <p>Separate delivery agreement and recording rights review required. These files are not
        harvested from provider websites. Staged audio is staff-only until approved.</p>
      {listing.isPending?<p role="status">Loading provider-delivery queue…</p>:null}
      {listing.isError?<p role="alert">{listing.error.message}</p>:null}
      {listing.data?<p>{listing.data.counts.map(x=>x.provider+" "+x.status+": "+x.n).join(" · ")||"No delivered tracks yet"}</p>:null}
      <ul>
        {listing.data?.records.map(x=><li key={x.id}>
          <button type="button" onClick={()=>{
            setSelected(x.id);setAssessment("");setReason("");
            setChecks({license:false,permission:false,listened:false});
          }}>{x.title} — {x.provider.toUpperCase()} ({x.status})</button>
        </li>)}
      </ul>
      {detail.isPending&&selected?<p role="status">Loading recording evidence…</p>:null}
      {detail.isError?<p role="alert">{detail.error.message}</p>:null}
      {row&&provenance?<section aria-label={"Review provider recording "+row.title}>
        <h3>{row.title}</h3>
        <p>{row.status} · {row.performer} · {row.composer} · {row.license_statement}</p>
        <p>SHA-256 of master: <code>{row.source_file_sha256}</code></p>
        <p>Source bytes: {row.source_size.toLocaleString()} · QA duration: {quality?.durationSeconds} seconds ·
          LUFS: {quality?.integratedLufs} · true peak: {quality?.truePeakDbfs} dBFS</p>
        <p><a href={row.source_page_url} target="_blank" rel="noopener noreferrer">Original provider recording page</a>{" "}
          <a href={row.license_url} target="_blank" rel="noopener noreferrer">Exact published license</a>{" "}
          <a href={provenance.grant?.evidenceUrl} target="_blank" rel="noopener noreferrer">Commercial provider / master grant</a></p>
        <p>Grant by: {provenance.grant?.grantingParty} ·
          Stated scope: {provenance.grant?.scope}</p>
        <p>Attribution: {row.attribution_text}</p>
        <details><summary>Five layers of recorded provenance</summary>
          {(["composition","arrangement","lyrics","performance","master"] as const).map(part=>{
            const evidence=provenance.rightsEvidence?.[part];
            return <section key={part}>
              <h4>{part}</h4><p>{evidence?.basis}</p>
              <ul>{(evidence?.evidenceUrls||[]).map((link:string)=><li key={link}>
                <a href={link} target="_blank" rel="noopener noreferrer">{link}</a></li>)}</ul>
            </section>;
          })}
        </details>
        {row.storage_key&&["staged","ready"].includes(row.status)?<>
          <p>Listen to the complete exact original before confirming its recording rights and editorial suitability.</p>
          <audio controls preload="none" src={"/api/fore/admin/soundtracks/external/"+row.id+"/audio"}
            aria-label={"Staff-only preview of "+row.title}/>
        </>:<p>This recording has no staff-previewable staged original.</p>}
        <fieldset disabled={busy||row.status!=="staged"}>
          <legend>Named staff commercial release assessment (MFA required)</legend>
          <label><input type="checkbox" checked={checks.license}
            onChange={e=>setChecks({...checks,license:e.target.checked})}/>
            I inspected the exact recording's source license and territory rights.</label>
          <label><input type="checkbox" checked={checks.permission}
            onChange={e=>setChecks({...checks,permission:e.target.checked})}/>
            I verified the provider's explicit commercial download and redistribution grant.</label>
          <label><input type="checkbox" checked={checks.listened}
            onChange={e=>setChecks({...checks,listened:e.target.checked})}/>
            I listened to the entire original file and checked performer/master credit.</label>
          <label>Evidence-based release rationale (at least 100 characters)
            <textarea rows={5} value={assessment} onChange={e=>setAssessment(e.target.value)}/>
          </label>
          <button type="button" disabled={busy||row.status!=="staged"||assessment.trim().length<100||
              !checks.license||!checks.permission||!checks.listened}
            onClick={()=>void decision("approve")}>Approve this recorded original for US playback</button>
        </fieldset>
        <fieldset disabled={busy||row.status==="revoked"||row.status==="rejected"}>
          <legend>Immediate withdrawal</legend>
          <label>Rights complaint or decision (at least 20 characters)
            <textarea rows={3} value={reason} onChange={e=>setReason(e.target.value)}/></label>
          <button type="button" disabled={busy||reason.trim().length<20}
            onClick={()=>void decision("revoke")}>Revoke playback and queue private object deletion</button>{" "}
          <button type="button" disabled={busy||reason.trim().length<20}
            onClick={()=>void decision("reject")}>Reject recording</button>
        </fieldset>
        <details><summary>Immutable decision history</summary>
          <ol>{detail.data?.history.map(e=><li key={e.id}>
            {e.created_at} — {e.event_type} by {e.actor}</li>)}</ol>
        </details>
      </section>:null}
      <p role="status" aria-live="polite">{notice}</p>
    </section>
  );
}

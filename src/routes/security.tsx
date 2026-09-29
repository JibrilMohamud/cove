import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/features/fore/App";

function SecurityPolicyPage(){
  const [contact,setContact]=useState(""),[title,setTitle]=useState(""),[summary,setSummary]=useState(""),[busy,setBusy]=useState(false),[result,setResult]=useState<{reference?:string;error?:string}|null>(null);
  async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setResult(null);try{const r=await fetch("/api/fore/security/disclosure",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({reporterContactRef:contact,title,summary})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d?.error||"Unable to submit this report.");setResult({reference:d.reference});setTitle("");setSummary("");}catch(e:any){setResult({error:e?.message||"Unable to submit this report."});}finally{setBusy(false)}}
  return <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 text-sm leading-6">
    <section><h1 className="text-3xl font-semibold">Security & vulnerability disclosure</h1><p className="mt-3 text-muted-foreground">Cove welcomes good-faith security research. Please avoid privacy violations, destructive testing, denial-of-service activity, social engineering, and accessing data beyond what is necessary to demonstrate a vulnerability.</p></section>
    <section><h2 className="text-xl font-semibold">Report a vulnerability</h2><p className="mt-2">Use this form or the contact published in <code>/.well-known/security.txt</code>. Include the affected surface, reproduction steps and likely impact. Do not include live credentials, payment-card data, or unrelated personal data.</p>
      <form className="mt-4 grid gap-3" onSubmit={submit}>
        <label className="grid gap-1"><span>Contact reference (optional)</span><input className="border bg-transparent p-2" value={contact} maxLength={1000} onChange={e=>setContact(e.target.value)} placeholder="Email or other secure contact route"/></label>
        <label className="grid gap-1"><span>Title</span><input className="border bg-transparent p-2" required minLength={1} maxLength={500} value={title} onChange={e=>setTitle(e.target.value)}/></label>
        <label className="grid gap-1"><span>Technical summary</span><textarea className="min-h-40 border bg-transparent p-2" required minLength={1} maxLength={20000} value={summary} onChange={e=>setSummary(e.target.value)}/></label>
        <button className="button gold w-fit" disabled={busy}>{busy?"Submitting…":"Submit security report"}</button>
      </form>
      {result?.reference&&<p className="mt-3"><strong>Received.</strong> Reference: <code>{result.reference}</code>. Keep this reference for follow-up.</p>}
      {result?.error&&<p className="mt-3" role="alert">{result.error}</p>}
    </section>
    <section><h2 className="text-xl font-semibold">Safe harbor</h2><p className="mt-2">When research is conducted in good faith, stays within these rules, and is promptly reported, Cove will treat it as authorized security research to the extent Cove can do so. Third-party systems remain subject to their owners' rules.</p></section>
    <section><h2 className="text-xl font-semibold">Response process</h2><p className="mt-2">Reports receive a durable reference, are triaged by severity, and remain tracked through remediation and retest. Public disclosure timing should be coordinated so affected customers can be protected first.</p></section>
  </div>
}

export const Route=createFileRoute("/security")({head:()=>({meta:[{title:"Security & Vulnerability Disclosure — Cove"}]}),component:()=> <SiteShell active="" title="Security"><SecurityPolicyPage/></SiteShell>});

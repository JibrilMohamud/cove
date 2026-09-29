import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type Market={countryCode:string;displayName:string;defaultLocale:string;defaultCurrency:string;taxInclusive:boolean;checkoutEnabled:boolean;locales:string[]};
type ContextValue={country:string;rightsCountry:string;locale:string;language:string;currency:string;direction:"ltr"|"rtl";taxInclusive:boolean;checkoutEnabled:boolean;paymentMethods:any[];markets:Market[];messages:Record<string,string>;t:(key:string,fallback?:string)=>string;formatMoney:(minor:number,currency?:string)=>string;setPreferences:(x:{country?:string;locale?:string;currency?:string})=>Promise<void>;loading:boolean};
const defaults:ContextValue={country:"US",rightsCountry:"US",locale:"en-US",language:"en",currency:"USD",direction:"ltr",taxInclusive:false,checkoutEnabled:true,paymentMethods:[],markets:[],messages:{},t:(_k,f)=>f||_k,formatMoney:(m)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(m/100),setPreferences:async()=>{},loading:true};
const StorefrontLocaleContext=createContext<ContextValue>(defaults);

async function fetchContext(){const r=await fetch("/api/fore/storefront/context",{credentials:"same-origin"});if(!r.ok)throw new Error("Storefront context unavailable");return r.json();}
export function StorefrontLocaleProvider({children}:{children:ReactNode}){
  const [raw,setRaw]=useState<any|null>(null);
  const load=async()=>{try{const x=await fetchContext();setRaw(x);document.documentElement.lang=x.locale||"en-US";document.documentElement.dir=x.direction==="rtl"?"rtl":"ltr";}catch{/* server fallback keeps the storefront usable */}};
  useEffect(()=>{void load()},[]);
  const value=useMemo<ContextValue>(()=>{
    const x=raw||{};const locale=String(x.locale||"en-US"),currency=String(x.currency||"USD"),messages=x.messages||{};
    return {country:String(x.storefrontCountry||"US"),rightsCountry:String(x.rightsCountry||x.storefrontCountry||"US"),locale,language:String(x.language||locale.split("-")[0]),currency,direction:x.direction==="rtl"?"rtl":"ltr",taxInclusive:!!x.taxInclusive,checkoutEnabled:x.checkoutEnabled!==false,paymentMethods:Array.isArray(x.paymentMethods)?x.paymentMethods:[],markets:Array.isArray(x.availableMarkets)?x.availableMarkets:[],messages,t:(key,fallback)=>String(messages[key]||fallback||key),formatMoney:(minor,c=currency)=>{try{return new Intl.NumberFormat(locale,{style:"currency",currency:c}).format(Number(minor||0)/100)}catch{return `${c} ${(Number(minor||0)/100).toFixed(2)}`}},setPreferences:async(pref)=>{const r=await fetch("/api/fore/storefront/context",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(pref)});if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error||"Could not update storefront preferences")}await load();location.reload();},loading:!raw};
  },[raw]);
  return <StorefrontLocaleContext.Provider value={value}>{children}</StorefrontLocaleContext.Provider>;
}
export const useStorefrontLocale=()=>useContext(StorefrontLocaleContext);

export function StorefrontLocaleControl(){
  const s=useStorefrontLocale();const market=s.markets.find(m=>m.countryCode===s.country);const locales=market?.locales?.length?market.locales:[s.locale];
  return <label className="storefront-locale-control" title={`${market?.displayName||s.country} · ${s.currency}`}><span>{s.t("store.country","Storefront")}</span><select aria-label="Storefront language" value={s.locale} onChange={e=>void s.setPreferences({locale:e.target.value})}>{locales.map(l=><option value={l} key={l}>{l}</option>)}</select><small>{s.country} · {s.currency}</small></label>;
}

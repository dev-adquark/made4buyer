import {normalize} from "./normalize"; import type {NormalizedReview} from "./types";
function timeoutMs(){const n=Number(process.env.CONTENT_API_TIMEOUT_MS||15000);return Number.isFinite(n)&&n>0?Math.min(n,60000):15000}
export async function fetchContent():Promise<NormalizedReview[]> {
 const url=process.env.CONTENT_API_URL;
 if(!url) throw new Error("CONTENT_API_URL is not configured");
 let endpoint:URL;try{endpoint=new URL(url)}catch{throw new Error("CONTENT_API_URL is invalid")}
 if(!["http:","https:"].includes(endpoint.protocol))throw new Error("CONTENT_API_URL must use http or https");
 const headers:Record<string,string>={Accept:"application/json"};
 if(process.env.CONTENT_API_KEY) headers.Authorization="Bearer "+process.env.CONTENT_API_KEY;
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs());
 try{
  const r=await fetch(endpoint,{headers,cache:"no-store",signal:controller.signal});
  if(!r.ok)throw new Error("Content API "+r.status);
  const d=await r.json();
  const items=Array.isArray(d)?d:(d&&typeof d==="object"&&Array.isArray((d as any).items)?(d as any).items:Array.isArray((d as any).results)?(d as any).results:Array.isArray((d as any).data)?(d as any).data:null);
  if(!items)throw new Error("Content API response must be an array or contain items/results/data array");
  return items.map(normalize);
 }catch(e){if(e instanceof Error&&e.name==="AbortError")throw new Error("Content API request timed out");throw e}
 finally{clearTimeout(timer)}
}
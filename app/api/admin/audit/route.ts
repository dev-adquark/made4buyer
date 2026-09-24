import {isAdmin}from"@/lib/auth";import{NextResponse}from"next/server";import net from"node:net";import dns from"node:dns/promises";
export const dynamic="force-dynamic";
const seeds=["/","/about","/privacy","/disclosure","/search","/compare","/robots.txt","/sitemap.xml"];
function blocked(a:string){const x=a.toLowerCase();return x==="127.0.0.1"||x==="::1"||x==="0.0.0.0"||x.startsWith("10.")||x.startsWith("192.168.")||x.startsWith("169.254.")||/^172\.(1[6-9]|2\d|3[0-1])\./.test(x)||x.startsWith("fc")||x.startsWith("fd")||x.startsWith("fe80:")}
async function safeOrigin(raw:string){const u=new URL(raw);if(!["http:","https:"].includes(u.protocol))return null;if(net.isIP(u.hostname))return blocked(u.hostname)?null:u;const records=await dns.lookup(u.hostname,{all:true});return records.length&&!records.some(x=>blocked(x.address))?u:null}
function internal(raw:string,origin:URL){try{const u=new URL(raw,origin);return u.origin===origin.origin&&["http:","https:"].includes(u.protocol)?(u.hash="",u.href):null}catch{return null}}
async function check(url:string){try{const r=await fetch(url,{redirect:"follow",cache:"no-store",headers:{accept:"text/html,application/xml,text/plain,*/*"}});return{url,status:r.status,ok:r.ok}}catch(e){return{url,status:0,ok:false,error:e instanceof Error?e.message:"request failed"}}}
export async function POST(req:Request){
 if(!await isAdmin())return NextResponse.json({error:"Unauthorized"},{status:401});
 const base=process.env.NEXT_PUBLIC_SITE_URL;if(!base)return NextResponse.json({error:"NEXT_PUBLIC_SITE_URL is not configured"},{status:503});
 let origin:URL;try{const safe=await safeOrigin(base);if(!safe)return NextResponse.json({error:"Audit base URL resolves to a private or blocked address"},{status:503});origin=safe}catch{return NextResponse.json({error:"NEXT_PUBLIC_SITE_URL is invalid"},{status:503})}
 const checked=new Map<string,Awaited<ReturnType<typeof check>>>();const errors:Awaited<ReturnType<typeof check>>[]=[];
 for(const path of seeds){const u=new URL(path,origin).href;const r=await check(u);checked.set(u,r);if(!r.ok)errors.push(r)}
 const sitemap=checked.get(new URL("/sitemap.xml",origin).href);
 if(sitemap?.ok)try{const r=await fetch(sitemap.url,{cache:"no-store"});const xml=await r.text();for(const match of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)){const u=internal(match[1].trim(),origin);if(u&&!checked.has(u)&&checked.size<300)checked.set(u,await check(u))}}catch{}
 for(const r of checked.values())if(!r.ok&&!errors.some(e=>e.url===r.url))errors.push(r);
 return NextResponse.json({base:origin.href,checked:checked.size,broken:errors.length,errors});
}
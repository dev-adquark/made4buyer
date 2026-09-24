import dns from "node:dns/promises";import net from "node:net";
function blockedAddress(address:string){
 const a=address.toLowerCase().replace(/^\[|\]$/g,"");
 if(a==="0.0.0.0"||a==="127.0.0.1"||a==="::1"||a==="::"||a.startsWith("127.")||a.startsWith("10.")||a.startsWith("192.168.")||a.startsWith("169.254.")||a.startsWith("::ffff:127.")||a.startsWith("::ffff:10.")||a.startsWith("::ffff:192.168.")||a.startsWith("::ffff:169.254."))return true;
 if(/^172\.(1[6-9]|2\d|3[0-1])\./.test(a)||/^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(a))return true;
 if(/^(fc|fd)/.test(a)||a.startsWith("fe80:")||a==="localhost")return true;
 return false;
}
async function allowed(raw:string){
 const u=new URL(raw);
 if(!["http:","https:"].includes(u.protocol))return false;
 const host=u.hostname.toLowerCase();
 if(host==="localhost"||host.endsWith(".localhost")||blockedAddress(host))return false;
 if(net.isIP(host)===0){
  const records=await dns.lookup(host,{all:true});
  if(!records.length||records.some(x=>blockedAddress(x.address)))return false;
 }
 return true;
}
export async function verifyLink(raw:string){
 try{
  let current=raw;
  const visited=new Set<string>();
  for(let i=0;i<5;i++){
   if(visited.has(current))return false;
   visited.add(current);
   if(!await allowed(current))return false;
   const r=await fetch(current,{method:"HEAD",redirect:"manual",cache:"no-store"});
   if(r.status>=300&&r.status<400){const location=r.headers.get("location");if(!location)return false;current=new URL(location,current).toString();continue}
   if(r.ok)return true;
   if([403,405,429].includes(r.status)){
    const fallback=await fetch(current,{method:"GET",redirect:"manual",cache:"no-store",headers:{"Range":"bytes=0-1023"}});
    if(fallback.status>=300&&fallback.status<400){const location=fallback.headers.get("location");if(!location)return false;current=new URL(location,current).toString();continue}
    return fallback.ok;
   }
   return false;
  }
  return false;
 }catch{return false}
}
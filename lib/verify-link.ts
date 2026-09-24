import dns from "node:dns/promises";
import net from "node:net";

function blockedAddress(address:string){
  const a=address.toLowerCase();
  if(a==="127.0.0.1"||a==="0.0.0.0"||a==="::1"||a.startsWith("10.")||a.startsWith("192.168.")||a.startsWith("169.254."))return true;
  if(/^172\.(1[6-9]|2\d|3[0-1])\./.test(a))return true;
  if(a.startsWith("fc")||a.startsWith("fd")||a.startsWith("fe80:"))return true;
  return false;
}
async function allowed(raw:string){
  const u=new URL(raw);
  if(!["http:","https:"].includes(u.protocol))return false;
  if(u.hostname==="localhost"||u.hostname.endsWith(".localhost")||blockedAddress(u.hostname))return false;
  if(net.isIP(u.hostname)===0){
    const records=await dns.lookup(u.hostname,{all:true});
    if(records.some(x=>blockedAddress(x.address)))return false;
  }else if(blockedAddress(u.hostname))return false;
  return true;
}
export async function verifyLink(raw:string){
  try{
    let current=raw;
    for(let i=0;i<5;i++){
      if(!await allowed(current))return false;
      const r=await fetch(current,{method:"HEAD",redirect:"manual",cache:"no-store"});
      if(r.status>=300&&r.status<400){
        const location=r.headers.get("location"); if(!location)return false;
        current=new URL(location,current).toString(); continue;
      }
      if(r.ok)return true;
      if([403,405,429].includes(r.status)){
        const fallback=await fetch(current,{method:"GET",redirect:"manual",cache:"no-store",headers:{"Range":"bytes=0-1023"}});
        if(fallback.status>=300&&fallback.status<400){
          const location=fallback.headers.get("location"); if(!location)return false;
          current=new URL(location,current).toString(); continue;
        }
        return fallback.ok;
      }
      return false;
    }
    return false;
  }catch{return false}
}
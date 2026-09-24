import dns from "node:dns/promises";
import net from "node:net";

function blockedHostname(hostname:string){
  const h=hostname.toLowerCase().replace(/\.$/,"");
  if(h==="localhost"||h.endsWith(".localhost")||h==="127.0.0.1"||h==="::1"||h==="0.0.0.0"||h.startsWith("10.")||h.startsWith("192.168.")||h.startsWith("169.254.")) return true;
  if(/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  return false;
}
export async function verifyLink(raw:string){
  try{
    const u=new URL(raw);
    if(!["http:","https:"].includes(u.protocol)||blockedHostname(u.hostname)||net.isIP(u.hostname)===6)return false;
    if(net.isIP(u.hostname)===0){
      const records=await dns.lookup(u.hostname,{all:true});
      if(records.some(x=>blockedHostname(x.address)||net.isIP(x.address)===6))return false;
    }
    const r=await fetch(u,{method:"HEAD",redirect:"follow",cache:"no-store"});
    if(r.ok)return true;
    if([403,405,429].includes(r.status)){
      const fallback=await fetch(u,{method:"GET",redirect:"follow",cache:"no-store",headers:{"Range":"bytes=0-1023"}});
      return fallback.ok;
    }
    return false;
  }catch{return false}
}
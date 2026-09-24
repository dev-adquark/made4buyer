import crypto from "crypto";import{cookies}from"next/headers";
const SESSION_MAX_AGE=8*60*60*1000;
const secret=()=>{const v=process.env.ADMIN_SESSION_SECRET;if(v)return v;if(process.env.NODE_ENV==="production")throw new Error("ADMIN_SESSION_SECRET is not configured");return"development-secret"};
export function sign(v:string){return crypto.createHmac("sha256",secret()).update(v).digest("hex")}
export async function isAdmin(){const c=await cookies();const v=c.get("admin_session")?.value;if(!v)return false;const p=v.split(".");if(p.length!==3||!p[0]||!p[1]||!p[2])return false;const ts=Number(p[0]);if(!Number.isFinite(ts)||Date.now()-ts<0||Date.now()-ts>SESSION_MAX_AGE)return false;const payload=p[0]+"."+p[1];const expected=sign(payload);try{return p[2].length===expected.length&&crypto.timingSafeEqual(Buffer.from(p[2]),Buffer.from(expected))}catch{return false}}
export function validAdmin(e:string,p:string){const email=process.env.ADMIN_EMAIL,password=process.env.ADMIN_PASSWORD;if(!email||!password)return false;return e===email&&p===password}
export const adminSessionMaxAge=Math.floor(SESSION_MAX_AGE/1000);
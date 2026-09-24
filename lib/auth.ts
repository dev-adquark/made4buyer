import crypto from "crypto"; import {cookies} from "next/headers";
const secret=()=>{const v=process.env.ADMIN_SESSION_SECRET;if(v)return v;if(process.env.NODE_ENV==="production")throw new Error("ADMIN_SESSION_SECRET is not configured");return "development-secret"};
export function sign(v:string){return crypto.createHmac("sha256",secret()).update(v).digest("hex")}
export async function isAdmin(){const c=await cookies();const v=c.get("admin_session")?.value;if(!v)return false;const p=v.split(".");if(!p[0]||!p[1])return false;const expected=sign(p[0]);try{return p[1].length===expected.length&&crypto.timingSafeEqual(Buffer.from(p[1]),Buffer.from(expected))}catch{return false}}
export function validAdmin(e:string,p:string){const email=process.env.ADMIN_EMAIL,password=process.env.ADMIN_PASSWORD;if(!email||!password)return false;return e===email&&p===password}

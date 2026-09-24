import crypto from "crypto"; import {cookies} from "next/headers";
const secret=()=>process.env.ADMIN_SESSION_SECRET||"development-secret";
export function sign(v:string){return crypto.createHmac("sha256",secret()).update(v).digest("hex")}
export async function isAdmin(){const c=await cookies();const v=c.get("admin_session")?.value;if(!v)return false;const p=v.split(".");return !!p[0]&&p[1]===sign(p[0])}
export function validAdmin(e:string,p:string){return e===process.env.ADMIN_EMAIL&&p===process.env.ADMIN_PASSWORD}
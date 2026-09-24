import {NextResponse} from "next/server";
import {isAdmin} from "@/lib/auth";
import {db} from "@/lib/db";

export async function POST(req:Request){
  if(!await isAdmin()) return NextResponse.json({error:"Unauthorized"},{status:401});
  const f=await req.formData();
  const id=String(f.get("id")||"");
  const title=String(f.get("title")||"").trim();
  const url=String(f.get("url")||"").trim();
  if(!title||!/^https?:\/\//i.test(url)) return NextResponse.json({error:"Valid title and http(s) URL required"},{status:422});
  const data={title,label:String(f.get("label")||"Sponsored").trim()||"Sponsored",url,active:f.get("active")==="on",minEvents:Math.max(0,Number(f.get("minEvents")||100)),minSessions:Math.max(0,Number(f.get("minSessions")||25)),startAt:f.get("startAt")?new Date(String(f.get("startAt"))):null,endAt:f.get("endAt")?new Date(String(f.get("endAt"))):null};
  if(id) await db.sponsoredPlacement.update({where:{id},data}); else await db.sponsoredPlacement.create({data});
  return NextResponse.redirect(new URL("/admin/sponsored",req.url));
}
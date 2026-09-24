import {NextResponse} from "next/server";
import {isAdmin} from "@/lib/auth";
import {db} from "@/lib/db";

function dateValue(value:FormDataEntryValue|null){
  if(!value)return null;
  const d=new Date(String(value));
  return Number.isNaN(d.getTime())?null:d;
}

export async function POST(req:Request){
  if(!await isAdmin()) return NextResponse.json({error:"Unauthorized"},{status:401});
  const f=await req.formData();
  const id=String(f.get("id")||"");
  const title=String(f.get("title")||"").trim();
  const url=String(f.get("url")||"").trim();
  if(!title||!/^https?:\/\//i.test(url)) return NextResponse.json({error:"Valid title and http(s) URL required"},{status:422});
  const startAt=dateValue(f.get("startAt"));
  const endAt=dateValue(f.get("endAt"));
  if(f.get("startAt")&& !startAt)return NextResponse.json({error:"Invalid start date"},{status:422});
  if(f.get("endAt")&& !endAt)return NextResponse.json({error:"Invalid end date"},{status:422});
  if(startAt&&endAt&&endAt<=startAt)return NextResponse.json({error:"End date must be after start date"},{status:422});
  const minEvents=Number(f.get("minEvents")||100),minSessions=Number(f.get("minSessions")||25);
  if(!Number.isFinite(minEvents)||!Number.isFinite(minSessions)||minEvents<0||minSessions<0)return NextResponse.json({error:"Thresholds must be non-negative numbers"},{status:422});
  const data={title,label:String(f.get("label")||"Sponsored").trim()||"Sponsored",url,active:f.get("active")==="on",minEvents:Math.floor(minEvents),minSessions:Math.floor(minSessions),startAt,endAt};
  if(id) await db.sponsoredPlacement.update({where:{id},data}); else await db.sponsoredPlacement.create({data});
  return NextResponse.redirect(new URL("/admin/sponsored",req.url));
}

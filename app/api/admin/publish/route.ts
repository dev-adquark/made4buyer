import {NextResponse} from "next/server"; import {isAdmin} from "@/lib/auth"; import {db} from "@/lib/db";
export async function POST(req:Request){
  if(!await isAdmin())return NextResponse.json({error:"Unauthorized"},{status:401});
  const f=await req.formData();const id=String(f.get("id")||"");
  const review=await db.review.findUnique({where:{id},include:{deals:{where:{verified:true}}}});
  if(!review)return NextResponse.json({error:"Review not found"},{status:404});
  const failures:string[]=[];
  if(review.title.length<8)failures.push("title");
  if(review.summary.length<20)failures.push("summary");
  if(review.body.length<120)failures.push("body");
  if(review.confidence<0.75)failures.push("confidence");
  if(failures.length)return NextResponse.json({error:"QA gate failed",fields:failures},{status:422});
  await db.review.update({where:{id},data:{status:"PUBLISHED",publishedAt:new Date()}});
  return NextResponse.redirect(new URL("/admin/qa",req.url));
}
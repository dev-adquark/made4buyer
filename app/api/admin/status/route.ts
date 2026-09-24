import{NextResponse}from"next/server";import{isAdmin}from"@/lib/auth";import{db}from"@/lib/db";
export async function POST(req:Request){
 if(!await isAdmin())return NextResponse.json({error:"Unauthorized"},{status:401});
 const f=await req.formData();const id=String(f.get("id")||"");const status=String(f.get("status")||"");
 if(!id||!["QUEUED","PUBLISHED","REJECTED","DRAFT"].includes(status))return NextResponse.json({error:"Invalid status change"},{status:422});
 const review=await db.review.findUnique({where:{id},select:{id:true,publishedAt:true}});
 if(!review)return NextResponse.json({error:"Review not found"},{status:404});
 await db.review.update({where:{id},data:{status:status as "QUEUED"|"PUBLISHED"|"REJECTED"|"DRAFT",publishedAt:status==="PUBLISHED"?(review.publishedAt??new Date()):review.publishedAt}});
 return NextResponse.redirect(new URL("/admin/qa",req.url))
}
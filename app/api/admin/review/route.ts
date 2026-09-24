import{NextResponse}from"next/server";import{isAdmin}from"@/lib/auth";import{db}from"@/lib/db";
function optional(v:FormDataEntryValue|null){const s=String(v??"").trim();return s||null}
export async function POST(req:Request){
 if(!await isAdmin())return NextResponse.json({error:"Unauthorized"},{status:401});
 const f=await req.formData();const id=String(f.get("id")||"");if(!id)return NextResponse.json({error:"Review id required"},{status:422});
 const review=await db.review.findUnique({where:{id},select:{id:true}});if(!review)return NextResponse.json({error:"Review not found"},{status:404});
 const title=String(f.get("title")||"").trim(),summary=String(f.get("summary")||"").trim(),body=String(f.get("body")||"").trim(),category=String(f.get("category")||"").trim();
 if(title.length<8||summary.length<20||body.length<120||!category)return NextResponse.json({error:"Title, summary, body and category are required"},{status:422});
 const confidence=Math.min(1,Math.max(0,Number(f.get("confidence")||0)));
 await db.review.update({where:{id},data:{title,summary,body,category,subcategory:optional(f.get("subcategory")),audience:optional(f.get("audience")),platform:optional(f.get("platform")),priceTier:optional(f.get("priceTier")),productName:optional(f.get("productName")),brand:optional(f.get("brand")),imageUrl:optional(f.get("imageUrl")),imageSource:optional(f.get("imageSource")),imageLicense:optional(f.get("imageLicense")),imageAttribution:optional(f.get("imageAttribution")),sourceUrl:optional(f.get("sourceUrl")),canonicalUrl:optional(f.get("canonicalUrl")),confidence}});
 return NextResponse.redirect(new URL("/admin/qa?edited=1",req.url))
}
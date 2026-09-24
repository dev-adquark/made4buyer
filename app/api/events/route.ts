import {db} from "@/lib/db"; import {NextResponse} from "next/server";
const allowed=new Set(["page_view","review_view","compare","search"]);
function cookieSession(req:Request){const m=req.headers.get("cookie")?.match(/(?:^|;\s*)made4buyers_session=([^;]+)/);return m?.[1]?decodeURIComponent(m[1]):undefined}
export async function POST(req:Request){
 try{
  const b=await req.json();
  const event=String(b.event||"");
  if(!allowed.has(event))return NextResponse.json({ok:false,error:"Unsupported event"},{status:422});
  const reviewId=typeof b.reviewId==="string"&&b.reviewId?b.reviewId:undefined;
  if(reviewId){
   const review=await db.review.findUnique({where:{id:reviewId},select:{status:true}});
   if(!review||review.status!=="PUBLISHED")return NextResponse.json({ok:false,error:"Invalid review"},{status:422});
  }
  const category=typeof b.category==="string"&&b.category?b.category.slice(0,120):undefined;
  const sessionId=typeof b.sessionId==="string"&&/^[a-zA-Z0-9_-]{10,100}$/.test(b.sessionId)?b.sessionId:undefined;
  const cookieId=cookieSession(req);
  if(!sessionId||!cookieId||sessionId!==cookieId)return NextResponse.json({ok:false,error:"Invalid session"},{status:422});
  await db.analyticsEvent.create({data:{reviewId,event,category,sessionId,metadata:typeof b.metadata==="object"&&b.metadata?b.metadata:undefined}});
  return NextResponse.json({ok:true});
 }catch{return NextResponse.json({ok:false},{status:400})}
}
import {db} from "./db";import {fetchContent} from "./content-api";import {findDeals} from "./sovrn";import {enrichImage} from "./images";import {verifyLink} from "./verify-link";
function slug(s:string){return s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,180)}
function cleanText(v:string){return v.replace(/\s+/g," ").trim()}
function validReview(item:{title:string;summary:string;body:string;productName:string;confidence:number}){return item.title.length>=8&&item.body.length>=120&&item.productName.length>=2&&item.summary.length>=20&&Number.isFinite(item.confidence)}
async function activeIngestion(){return db.ingestionRun.findFirst({where:{status:"RUNNING"},select:{id:true}})}
export async function runIngestion(){
 if(await activeIngestion())throw new Error("An ingestion run is already in progress");
 const run=await db.ingestionRun.create({data:{source:process.env.CONTENT_API_URL||"unconfigured",status:"RUNNING"}});
 let accepted=0,rejected=0,duplicate=0;const errors:string[]=[];
 try{
  const items=await fetchContent();
  for(const item of items){
   try{
    const normalized={...item,title:cleanText(item.title),summary:cleanText(item.summary),body:item.body.trim(),productName:cleanText(item.productName),confidence:Math.min(1,Math.max(0,item.confidence))};
    if(!validReview(normalized)){rejected++;continue}
    const canonical=normalized.canonicalUrl||normalized.sourceUrl;
    const sourceDuplicate=await db.review.findUnique({where:{sourceId:normalized.sourceId}});
    const canonicalDuplicate=canonical?await db.review.findFirst({where:{canonicalUrl:canonical}}):null;
    if(sourceDuplicate||canonicalDuplicate){duplicate++;continue}
    let finalSlug=slug(normalized.title)||"review";
    if(await db.review.findUnique({where:{slug:finalSlug}}))finalSlug=finalSlug+"-"+normalized.sourceId.slice(0,10).toLowerCase().replace(/[^a-z0-9]/g,"");
    const image=await enrichImage(normalized.productName,normalized.imageUrl);
    const review=await db.review.create({data:{sourceId:normalized.sourceId,title:normalized.title,slug:finalSlug,summary:normalized.summary,body:normalized.body,productName:normalized.productName,brand:normalized.brand,category:normalized.category,subcategory:normalized.subcategory,audience:normalized.audience,platform:normalized.platform,priceTier:normalized.priceTier,imageUrl:image?.url,imageSource:image?.source||normalized.imageSource,imageLicense:image?.license||normalized.imageLicense,imageAttribution:image?.attribution||normalized.imageAttribution,sourceUrl:normalized.sourceUrl,canonicalUrl:normalized.canonicalUrl,confidence:normalized.confidence,status:"QUEUED"}});
    try{const deals=await findDeals(normalized.productName);for(const d of deals.slice(0,5))if(await verifyLink(d.url))await db.deal.create({data:{reviewId:review.id,...d,verified:true,lastChecked:new Date()}})}
    catch(error){errors.push(normalized.sourceId+": deal lookup: "+String(error))}
    accepted++;
   }catch(error){errors.push(item.sourceId+": item processing: "+String(error));rejected++}
  }
  await db.ingestionRun.update({where:{id:run.id},data:{finishedAt:new Date(),status:"COMPLETED",total:items.length,accepted,rejected,duplicate,errors:errors.length?errors:undefined}});
  return{total:items.length,accepted,rejected,duplicate,errors:errors.length};
 }catch(error){await db.ingestionRun.update({where:{id:run.id},data:{finishedAt:new Date(),status:"FAILED",errors:{message:String(error)}}});throw error}
}
export async function revalidateDeals(){const deals=await db.deal.findMany({select:{id:true,url:true}});let valid=0;for(const d of deals){const ok=await verifyLink(d.url);await db.deal.update({where:{id:d.id},data:{verified:ok,lastChecked:new Date()}});if(ok)valid++}return{checked:deals.length,valid}}

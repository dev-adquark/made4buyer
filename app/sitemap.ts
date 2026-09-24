import{db}from"@/lib/db";import type{MetadataRoute}from"next";
export const dynamic="force-dynamic";
const slugify=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
const knownCategories=["Computers","Phones","Tablets","Computer Accessories","Audio","Storage","Networking","Cameras","Wearables","TV & Home Theater","Developer Software","AI Tools","Security Software","Business Software"];
const staticPaths=["/","/search","/compare","/about","/privacy","/disclosure"];
export default async function sitemap():Promise<MetadataRoute.Sitemap>{
 const base=process.env.NEXT_PUBLIC_SITE_URL||"http://localhost:3000";
 const baseEntries=staticPaths.map(path=>({url:base+path}));
 if(!process.env.DATABASE_URL)return[...baseEntries,...knownCategories.map(category=>({url:base+"/category/"+slugify(category)}))];
 const [reviews,categories]=await Promise.all([
  db.review.findMany({where:{status:"PUBLISHED"},select:{slug:true,updatedAt:true}}),
  db.review.findMany({where:{status:"PUBLISHED"},distinct:["category"],select:{category:true}})
 ]);
 const categoryNames=[...new Set([...knownCategories,...categories.map(x=>x.category)])];
 return[...baseEntries,...categoryNames.map(category=>({url:base+"/category/"+slugify(category)})),...reviews.map(r=>({url:base+"/reviews/"+r.slug,lastModified:r.updatedAt}))];
}
import {db} from "@/lib/db";import Link from"next/link";import type{Metadata}from"next";
export const dynamic="force-dynamic";
const slugify=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
const site=()=>process.env.NEXT_PUBLIC_SITE_URL||"http://localhost:3000";
const KNOWN_CATEGORIES:Record<string,string>={
 "computers":"Computers",
 "phones":"Phones",
 "tablets":"Tablets",
 "computer-accessories":"Computer Accessories",
 "audio":"Audio",
 "storage":"Storage",
 "networking":"Networking",
 "cameras":"Cameras",
 "wearables":"Wearables",
 "tv-home-theater":"TV & Home Theater",
 "developer-software":"Developer Software",
 "ai-tools":"AI Tools",
 "security-software":"Security Software",
 "business-software":"Business Software"
};
async function resolveCategory(slug:string){
 const known=KNOWN_CATEGORIES[slug];
 if(known)return known;
 const rows=await db.review.findMany({where:{status:"PUBLISHED"},distinct:["category"],select:{category:true}});
 return rows.map(x=>x.category).find(x=>slugify(x)===slug);
}
export async function generateMetadata({params}:{params:Promise<{slug:string}>}):Promise<Metadata>{
 const p=await params;const category=await resolveCategory(p.slug);if(!category)return{};
 const canonical=new URL("/category/"+slugify(category),site()).toString();
 return{title:category,description:"Current reviews and buyer research for "+category.toLowerCase()+".",alternates:{canonical},openGraph:{title:category,description:"Current reviews and buyer research for "+category.toLowerCase()+".",url:canonical}};
}
export default async function Category({params}:{params:Promise<{slug:string}>}){
 const p=await params;const category=await resolveCategory(p.slug);
 if(!category)return <main className="section"><div className="container"><h1>Category not found</h1><p className="muted">This category is not currently available.</p><Link className="btn" href="/">Back to home</Link></div></main>;
 const reviews=await db.review.findMany({where:{status:"PUBLISHED",category:{equals:category,mode:"insensitive"}},orderBy:{publishedAt:"desc"}});
 return <main className="section"><div className="container"><div className="eyebrow">Category</div><h1>{category}</h1><p className="muted">Current reviews and buyer research for {category.toLowerCase()}.</p>{reviews.length?<div className="grid">{reviews.map(r=><Link className="card" href={"/reviews/"+r.slug} key={r.id}><div className="thumb">{r.imageUrl?<img src={r.imageUrl} alt={r.productName||"Product"} style={{width:"100%",height:"100%",objectFit:"cover"}}/>:"Product image"}</div><div className="card-body"><div className="meta">{r.brand||r.productName}</div><h3>{r.title}</h3><p className="muted">{r.summary}</p></div></Link>)}</div>:<div className="card"><div className="card-body"><h2>No published reviews yet</h2><p className="muted">This category is active, but no reviews have passed publishing QA yet.</p></div></div>}</div></main>;
}
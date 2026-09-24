import Link from "next/link"; import {db} from "@/lib/db";
export const dynamic="force-dynamic";
export default async function Home(){
  const [reviews,placement]=await Promise.all([
    db.review.findMany({where:{status:"PUBLISHED"},orderBy:{publishedAt:"desc"},take:9}),
    db.sponsoredPlacement.findFirst({where:{active:true,AND:[{OR:[{startAt:null},{startAt:{lte:new Date()}}]},{OR:[{endAt:null},{endAt:{gte:new Date()}}]}]}})
  ]);
  const since=new Date(Date.now()-30*24*60*60*1000);
  let sponsoredEligible=false;
  if(placement){
    const [events,sessions]=await Promise.all([
      db.analyticsEvent.count({where:{createdAt:{gte:since}}}),
      db.analyticsEvent.findMany({where:{createdAt:{gte:since},sessionId:{not:null}},select:{sessionId:true},distinct:["sessionId"]})
    ]);
    sponsoredEligible=events>=placement.minEvents&&sessions.length>=placement.minSessions;
  }
  const cats=["Laptops","Phones","AI Tools","Developer Software","Accessories"];
  return <><section className="hero"><div className="container"><div className="eyebrow">Independent technology research</div><h1>Find the right tech without the guesswork.</h1><p>Current reviews, practical comparisons and live offer coverage for products and software people actually use.</p>{sponsoredEligible&&placement&&<div className="sponsor"><span>{placement.label}</span><a href={placement.url} rel="sponsored nofollow" target="_blank">{placement.title}</a></div>}<div className="chips">{cats.map(c=><Link className="chip" key={c} href={"/category/"+c.toLowerCase().replaceAll(" ","-")}>{c}</Link>)}</div></div></section><section className="section"><div className="container"><h2>Latest reviews</h2><div className="grid">{reviews.length?reviews.map(r=><Link className="card" href={"/reviews/"+r.slug} key={r.id}><div className="thumb">{r.imageUrl?<img src={r.imageUrl} alt={r.productName||"Product"} style={{width:"100%",height:"100%",objectFit:"cover"}}/>:"Product image"}</div><div className="card-body"><div className="meta">{r.category} · {r.brand||r.productName}</div><h3>{r.title}</h3><p className="muted">{r.summary}</p></div></Link>):<div className="card"><div className="card-body"><h3>Publishing pipeline ready</h3><p className="muted">Connect the Content API and run ingestion from the admin panel.</p><Link className="btn primary" href="/admin">Open admin</Link></div></div>}</div></div></section></>}
import {db} from "@/lib/db"; import {isAdmin} from "@/lib/auth"; import {redirect} from "next/navigation";
export const dynamic="force-dynamic";
export default async function Analytics(){
  if(!await isAdmin())redirect("/admin/login");
  const since=new Date(Date.now()-30*24*60*60*1000);
  const [published,views,clicks,compares,searches,sessions,events,categories]=await Promise.all([
    db.review.count({where:{status:"PUBLISHED"}}),
    db.analyticsEvent.count({where:{event:"page_view",createdAt:{gte:since}}}),
    db.analyticsEvent.count({where:{event:"affiliate_click",createdAt:{gte:since}}}),
    db.analyticsEvent.count({where:{event:"compare",createdAt:{gte:since}}}),
    db.analyticsEvent.count({where:{event:"search",createdAt:{gte:since}}}),
    db.analyticsEvent.findMany({where:{createdAt:{gte:since},sessionId:{not:null}},select:{sessionId:true},distinct:["sessionId"]}),
    db.analyticsEvent.groupBy({by:["event","category"],where:{createdAt:{gte:since}},_count:{_all:true},orderBy:{_count:{event:"desc"}}}),
    db.analyticsEvent.groupBy({by:["category"],where:{createdAt:{gte:since},category:{not:null}},_count:{_all:true},orderBy:{_count:{category:"desc"}}})
  ]);
  return <main className="admin"><div className="container"><h1>Analytics</h1><p className="muted">First-party metrics for the last 30 days. No fabricated traffic is used.</p>
  <div className="stats"><div className="stat">Published<b>{published}</b></div><div className="stat">Views<b>{views}</b></div><div className="stat">Affiliate clicks<b>{clicks}</b></div><div className="stat">Sessions<b>{sessions.length}</b></div></div>
  <div className="stats"><div className="stat">Compare events<b>{compares}</b></div><div className="stat">Search events<b>{searches}</b></div></div>
  <section className="section"><h2>Events</h2><table className="table"><thead><tr><th>Event</th><th>Category</th><th>Count</th></tr></thead><tbody>{events.map((e,i)=><tr key={i}><td>{e.event}</td><td>{e.category||"—"}</td><td>{e._count._all}</td></tr>)}</tbody></table></section>
  <section className="section"><h2>Top categories</h2><table className="table"><thead><tr><th>Category</th><th>Events</th></tr></thead><tbody>{categories.map((c,i)=><tr key={i}><td>{c.category}</td><td>{c._count._all}</td></tr>)}</tbody></table></section>
  </div></main>;
}
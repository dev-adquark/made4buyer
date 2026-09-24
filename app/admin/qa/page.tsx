import {db} from "@/lib/db"; import {isAdmin} from "@/lib/auth"; import {redirect} from "next/navigation";
export const dynamic="force-dynamic";
export default async function QA(){
  if(!await isAdmin())redirect("/admin/login");
  const rows=await db.review.findMany({include:{deals:true},orderBy:{createdAt:"desc"},take:100});
  return <main className="admin"><div className="container"><h1>QA & publishing</h1><p className="muted">Every row shows the checks that control publishing. A review needs valid content and confidence ≥75%.</p>
  <table className="table"><thead><tr><th>Review</th><th>Taxonomy</th><th>Image</th><th>Deals</th><th>Verified</th><th>State</th><th>Action</th></tr></thead><tbody>
  {rows.map(r=>{const verified=r.deals.filter(d=>d.verified).length;const failures=[r.title.length<8&&"title",r.summary.length<20&&"summary",r.body.length<120&&"body",r.confidence<.75&&"confidence"].filter(Boolean) as string[];return <tr key={r.id}>
  <td><strong>{r.title}</strong><br/><span className="muted">{r.productName||"—"}</span></td>
  <td>{r.category}<br/><span className="muted">{r.subcategory||"No subcategory"} · {Math.round(r.confidence*100)}%</span></td>
  <td>{r.imageUrl?<span className="ok">Ready</span>:<span className="warn">Missing</span>}{r.imageUrl&&<><br/><span className="muted">{r.imageSource||"source unknown"}</span></>}</td>
  <td>{r.deals.length}</td><td>{verified}</td><td>{r.status}{failures.length>0&&<><br/><span className="warn">QA: {failures.join(", ")}</span></>}</td>
  <td>{failures.length===0?<form action="/api/admin/publish" method="post"><input type="hidden" name="id" value={r.id}/><button className="btn" type="submit">{r.status==="PUBLISHED"?"Republish":"Publish"}</button></form>:<span className="muted">Fix QA</span>}</td>
  </tr>})}</tbody></table></div></main>
import {db} from "@/lib/db";
import {isAdmin} from "@/lib/auth";
import {redirect} from "next/navigation";

export const dynamic="force-dynamic";

export default async function Sponsored(){
  if(!await isAdmin()) redirect("/admin/login");
  const rows=await db.sponsoredPlacement.findMany({orderBy:{createdAt:"desc"}});
  return <main className="admin"><div className="container">
    <h1>Sponsored placements</h1>
    <p className="muted">Placements remain hidden until real 30-day event and unique-session thresholds are met.</p>
    <form className="sponsor-form" action="/api/admin/sponsored" method="post">
      <input name="title" placeholder="Placement title" required/>
      <input name="label" placeholder="Sponsored" defaultValue="Sponsored"/>
      <input name="url" type="url" placeholder="https://..." required/>
      <label>Minimum events<input name="minEvents" type="number" min="0" defaultValue="100"/></label>
      <label>Minimum sessions<input name="minSessions" type="number" min="0" defaultValue="25"/></label>
      <label>Start<input name="startAt" type="datetime-local"/></label>
      <label>End<input name="endAt" type="datetime-local"/></label>
      <label><input name="active" type="checkbox"/> Active</label>
      <button className="btn primary" type="submit">Create placement</button>
    </form>
    <table className="table"><thead><tr><th>Placement</th><th>Threshold</th><th>Window</th><th>Status</th><th>Action</th></tr></thead><tbody>
      {rows.map(r=><tr key={r.id}>
        <td><strong>{r.title}</strong><br/><span className="muted">{r.url}</span></td>
        <td>{r.minEvents} events<br/>{r.minSessions} sessions</td>
        <td>{r.startAt?.toLocaleString()||"Any"} → {r.endAt?.toLocaleString()||"Any"}</td>
        <td>{r.active?"Active":"Off"}</td>
        <td><form action="/api/admin/sponsored" method="post">
          <input type="hidden" name="id" value={r.id}/><input type="hidden" name="title" value={r.title}/><input type="hidden" name="label" value={r.label}/><input type="hidden" name="url" value={r.url}/><input type="hidden" name="minEvents" value={r.minEvents}/><input type="hidden" name="minSessions" value={r.minSessions}/>
          <input type="hidden" name="active" value={r.active?"":"on"}/>
          <button className="btn" type="submit">{r.active?"Disable":"Enable"}</button>
        </form></td>
      </tr>)}
    </tbody></table>
  </div></main>;
}
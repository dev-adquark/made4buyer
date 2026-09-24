import{NextResponse}from"next/server";import{validAdmin,createSession,adminSessionMaxAge}from"@/lib/auth";
export async function POST(req:Request){
 const f=await req.formData();const email=String(f.get("email")||"");const password=String(f.get("password")||"");
 if(!validAdmin(email,password))return NextResponse.redirect(new URL("/admin/login?error=1",req.url));
 const res=NextResponse.redirect(new URL("/admin",req.url));
 res.cookies.set("admin_session",createSession(email),{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",path:"/",maxAge:adminSessionMaxAge});
 return res
}
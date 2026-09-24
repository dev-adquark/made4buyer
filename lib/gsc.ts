import crypto from "node:crypto";

type GscRow={keys?:string[];clicks?:number;impressions?:number;ctr?:number;position?:number};
type GscApiResponse={rows?:GscRow[]};
export type GscSummary={clicks:number;impressions:number;ctr:number;position:number;rows:GscRow[];startDate:string;endDate:string};

const b64=(v:string|Buffer)=>Buffer.from(v).toString("base64url");
const required=(n:string)=>{const v=process.env[n];if(!v)throw new Error(n+" is not configured");return v};

async function accessToken(){
  let a:{client_email?:string;private_key?:string};
  try{a=JSON.parse(required("GSC_SERVICE_ACCOUNT_JSON"))}
  catch{throw new Error("GSC_SERVICE_ACCOUNT_JSON is not valid JSON")}
  if(!a.client_email||!a.private_key)throw new Error("GSC_SERVICE_ACCOUNT_JSON is invalid");
  const now=Math.floor(Date.now()/1000);
  const h=b64(JSON.stringify({alg:"RS256",typ:"JWT"}));
  const c=b64(JSON.stringify({iss:a.client_email,scope:"https://www.googleapis.com/auth/webmasters.readonly",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600}));
  const input=h+"."+c;
  const s=crypto.createSign("RSA-SHA256");s.update(input);
  const assertion=input+"."+s.sign(a.private_key,"base64url");
  const body=new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion});
  const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body,cache:"no-store"});
  if(!r.ok)throw new Error("Google token request failed: "+r.status);
  const d=await r.json() as {access_token?:string};
  if(!d.access_token)throw new Error("Google token response missing access_token");
  return d.access_token;
}

async function query(site:string,token:string,startDate:string,endDate:string,dimensions:string[]){
  const endpoint="https://www.googleapis.com/webmasters/v3/sites/"+encodeURIComponent(site)+"/searchAnalytics/query";
  const r=await fetch(endpoint,{method:"POST",headers:{Authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({startDate,endDate,dimensions,rowLimit:25000,startRow:0}),cache:"no-store"});
  if(!r.ok)throw new Error("Search Console query failed: "+r.status);
  return await r.json() as GscApiResponse;
}

export async function querySearchConsole(startDate:string,endDate:string):Promise<GscSummary>{
  const site=required("GSC_SITE_URL");
  const token=await accessToken();
  const daily=(await query(site,token,startDate,endDate,["date"])).rows||[];
  const overall=(await query(site,token,startDate,endDate,[])).rows?.[0];
  const clicks=overall?.clicks??daily.reduce((n,x)=>n+(x.clicks||0),0);
  const impressions=overall?.impressions??daily.reduce((n,x)=>n+(x.impressions||0),0);
  const ctr=overall?.ctr??(impressions?clicks/impressions:0);
  const position=overall?.position??0;
  return{clicks,impressions,ctr,position,rows:daily,startDate,endDate};
}

// Bellows Cloud landing Worker; generated PAGE and FAVICON from build.mjs.
const SECURITY_HEADERS={
'X-Content-Type-Options':'nosniff',
'Referrer-Policy':'strict-origin-when-cross-origin',
'X-Frame-Options':'DENY',
'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};
const JSON_HEADERS={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...SECURITY_HEADERS};
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:JSON_HEADERS});}
function content(body,type='text/html; charset=utf-8',status=200){return new Response(body,{status,headers:{...SECURITY_HEADERS,'Content-Type':type,'Cache-Control':'public, max-age=120'}});}
const SIZES=['','1-10','11-20','21-50','51-200','200+'];
const INTERESTS=['demo','pilot','design-partner','product-chat','enterprise','other'];
function clean(v,max){return typeof v==='string'?v.trim().slice(0,max+1):'';}
async function handleContact(request,env){
 const origin=request.headers.get('Origin'), currentOrigin=new URL(request.url).origin;
 if(origin&&origin!==currentOrigin)return json({ok:false,error:'Invalid form origin.'},403);
 if(!(request.headers.get('Content-Type')||'').toLowerCase().startsWith('application/json'))return json({ok:false,error:'JSON form required.'},415);
 if(Number(request.headers.get('Content-Length')||0)>12000)return json({ok:false,error:'Request too large.'},413);
 let d;try{d=await request.json();}catch{return json({ok:false,error:'Invalid request.'},400);}
 if(!d||typeof d!=='object'||Array.isArray(d))return json({ok:false,error:'Invalid request.'},400);
 if(d.website)return json({ok:true}); // Honeypot: no write
 const name=clean(d.name,100), email=clean(d.email,180).toLowerCase(), company=clean(d.company,150),
 team=clean(d.team_size,20), interest=clean(d.interest,20), message=clean(d.message,3000);
 if(!name||name.length>100||!email||email.length>180||!(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))
 ||company.length>150||message.length>3000||!SIZES.includes(team)||!INTERESTS.includes(interest)||d.consent!==true)
 return json({ok:false,error:'Check the required fields and consent.'},422);
 if(!env.LEADS_DB)return json({ok:false,error:'Form temporarily unavailable.'},503);
 const ip=request.headers.get('CF-Connecting-IP')||'unknown', hour=new Date().toISOString().slice(0,13);
 const bytes=new TextEncoder().encode(hour+'|'+ip+'|'+(env.RATE_LIMIT_SALT||'bellows-public-form'));
 const digest=await crypto.subtle.digest('SHA-256',bytes);
 const hash=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
 try{
  const row=await env.LEADS_DB.prepare("SELECT COUNT(*) AS count FROM leads WHERE ip_hash=? AND created_at >= datetime('now','-1 hour')").bind(hash).first();
  if(Number(row?.count||0)>=5)return json({ok:false,error:'Too many requests. Please try again later.'},429);
  await env.LEADS_DB.prepare('INSERT INTO leads (id,name,email,company,team_size,interest,message,consent,ip_hash,user_agent) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(),name,email,company,team,interest,message,1,hash,clean(request.headers.get('User-Agent'),250)).run();
  return json({ok:true});
 }catch(err){console.error('Bellows lead store failed',err?.message||'database error');return json({ok:false,error:'Could not save your request. Please try again.'},503);}
}
export default {async fetch(request,env){
 const url=new URL(request.url);
 if(url.hostname==='www.bellows.cloud'){url.hostname='bellows.cloud';return Response.redirect(url.toString(),301);}
 if(url.pathname==='/api/contact'){
  if(request.method!=='POST')return json({ok:false,error:'Method not allowed'},405);
  return handleContact(request,env);
 }
 if(request.method!=='GET'&&request.method!=='HEAD')return content('Method not allowed','text/plain',405);
 if(url.pathname==='/favicon.svg')return content(FAVICON,'image/svg+xml');
 if(url.pathname==='/'||url.pathname==='/index.html')return content(PAGE);
 if(url.pathname==='/robots.txt')return content('User-agent: *\nDisallow: /\n','text/plain');
 return content('Not found','text/plain',404);
}};

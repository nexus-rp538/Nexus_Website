import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import {readFileSync,mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
const secret=process.env.BRIDGE_SECRET;
const bridgeReady=!!secret&&secret.length>=32&&!secret.includes('REPLACE');
if(!bridgeReady) console.warn('FiveM linking disabled: configure BRIDGE_SECRET');
const origin=new URL(process.env.PUBLIC_URL||(process.env.RAILWAY_PUBLIC_DOMAIN?'https://'+process.env.RAILWAY_PUBLIC_DOMAIN:null)||process.env.API_PUBLIC_URL||'http://localhost:3000').origin;
const dbPath=process.env.DB_PATH||join(process.env.RAILWAY_VOLUME_MOUNT_PATH||process.env.DATA_DIR||'.','nexus-queue.sqlite');
mkdirSync(dirname(dbPath),{recursive:true});
const db=new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, license TEXT UNIQUE, priority INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER,expires INTEGER);`);
const codes=new Map(), states=new Map(), rates=new Map();
const hash=x=>createHash('sha256').update(x).digest('hex');
const safe=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)};
const password=(p,salt=randomBytes(16).toString('hex'))=>`${salt}:${scryptSync(p,salt,64).toString('hex')}`;
const check=(p,v)=>safe(password(p,v.split(':')[0]),v);
const me=req=>{const t=/\bnq=([a-f0-9]{64})\b/.exec(req.headers.cookie||'')?.[1];return t&&db.prepare('SELECT u.id,u.username,u.license,u.priority FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(hash(t),Date.now());};
const send=(res,status,data,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(data));};
const limited=(key,max)=>{const t=Date.now();let v=rates.get(key);if(!v||v.until<t){v={n:0,until:t+60000};rates.set(key,v)}return ++v.n>max};
async function body(req){let b='';for await(const c of req){b+=c;if(b.length>16384)throw Error('body too large')}return JSON.parse(b||'{}')}
setInterval(()=>{const now=Date.now();for(const [k,v] of codes)if(v.expires<now)codes.delete(k);for(const [k,v] of rates)if(v.until<now)rates.delete(k);for(const [k,v] of states)if(v.updated<now-120000)states.delete(k);db.prepare('DELETE FROM sessions WHERE expires<?').run(now)},60000).unref();
const server=http.createServer(async(req,res)=>{try{
 const path=new URL(req.url,'http://local').pathname;
 if(path==='/health'&&req.method==='GET')return send(res,200,{ok:true});
 if(path.startsWith('/bridge/')){
  if(!bridgeReady)return send(res,503,{error:'FiveM bridge is not configured'});
  if(!safe(req.headers.authorization||'',`Bearer ${secret}`))return send(res,401,{error:'Unauthorized'});
  if(req.method!=='POST')return send(res,405,{});
  const b=await body(req);if(typeof b.license!=='string'||!/^license:[a-fA-F0-9]+$/.test(b.license))return send(res,400,{error:'Invalid license'});
  if(path==='/bridge/identity'){
   const u=db.prepare('SELECT username,priority FROM users WHERE license=?').get(b.license);
   if(u)return send(res,200,{registered:true,...u});
   // Each attempt replaces the old challenge; never expose a client-selected identity.
   for(const [k,v] of codes)if(v.license===b.license)codes.delete(k);
   const code=randomBytes(6).toString('hex').toUpperCase();codes.set(code,{license:b.license,expires:Date.now()+300000});
   return send(res,200,{registered:false,code});
  }
  if(path==='/bridge/status'){states.set(b.license,{position:Number(b.position)||0,total:Number(b.total)||0,status:String(b.status).slice(0,32),graceUntil:Number(b.graceUntil)||0,updated:Date.now()});return send(res,200,{ok:true})}
  return send(res,404,{});
 }
 if(path.startsWith('/api/')){
  if(limited(req.socket.remoteAddress+':all',180))return send(res,429,{error:'حاول بعد دقيقة'});
  if(req.method==='POST'&&req.headers.origin!==origin)return send(res,403,{error:'Invalid origin'});
  const u=me(req);
  if(path==='/api/config'&&req.method==='GET')return send(res,200,{connect:process.env.CONNECT_URL||'',name:'NEXUS',bridgeReady});
  if(path==='/api/me'&&req.method==='GET')return send(res,200,{user:u||null,queue:u?.license?(states.get(u.license)||null):null});
  if(req.method!=='POST')return send(res,405,{});
  const b=await body(req);
  if(path==='/api/register'||path==='/api/login'){
   if(limited(req.socket.remoteAddress+':auth',10))return send(res,429,{error:'محاولات كثيرة؛ انتظر دقيقة'});
   const {username,password:p}=b;if(typeof username!=='string'||! /^[a-zA-Z0-9_]{3,24}$/.test(username)||typeof p!=='string'||p.length<10||p.length>128)return send(res,400,{error:'اسم إنجليزي 3–24 حرف وكلمة مرور 10–128 حرف'});
   let a=db.prepare('SELECT * FROM users WHERE username=?').get(username);
   if(path==='/api/register'){if(a)return send(res,409,{error:'الاسم مستخدم'});db.prepare('INSERT INTO users(username,pass) VALUES(?,?)').run(username,password(p));a=db.prepare('SELECT * FROM users WHERE username=?').get(username)}
   else if(!a||!check(p,a.pass))return send(res,401,{error:'بيانات الدخول غير صحيحة'});
   const t=randomBytes(32).toString('hex');db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(t),a.id,Date.now()+604800000);
   return send(res,200,{ok:true},{'Set-Cookie':`nq=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.COOKIE_SECURE==='false'?'':'; Secure'}`});
  }
  if(!u)return send(res,401,{error:'سجل الدخول أولًا'});
  if(path==='/api/link'){
   if(limited(`link:${u.id}`,5))return send(res,429,{error:'انتظر دقيقة قبل المحاولة'});
   const c=String(b.code||'').trim().toUpperCase(),v=codes.get(c);
   if(!v||v.expires<Date.now())return send(res,400,{error:'الكود غير صحيح أو انتهت صلاحيته'});
   if(u.license)return send(res,409,{error:'حسابك مربوط بالفعل'});
   if(db.prepare('SELECT id FROM users WHERE license=?').get(v.license))return send(res,409,{error:'هوية اللعبة مربوطة بحساب آخر'});
   db.prepare('UPDATE users SET license=? WHERE id=?').run(v.license,u.id);codes.delete(c);return send(res,200,{ok:true});
  }
  if(path==='/api/logout'){const t=/\bnq=([a-f0-9]{64})\b/.exec(req.headers.cookie||'')?.[1];if(t)db.prepare('DELETE FROM sessions WHERE token=?').run(hash(t));return send(res,200,{ok:true},{'Set-Cookie':'nq=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'})}
  return send(res,404,{});
 }
 const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};const f=files[path];if(!f)return send(res,404,{});
 res.writeHead(200,{'Content-Type':f[1],'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",'Referrer-Policy':'no-referrer'});res.end(readFileSync(new URL('./public/'+f[0],import.meta.url)));
}catch(e){console.error('Request failed:',e.message);if(!res.headersSent)send(res,400,{error:'تعذر تنفيذ الطلب'});else res.end()}});
server.listen(Number(process.env.PORT||3000),process.env.HOST||'0.0.0.0',()=>console.log('NEXUS queue web ready'));

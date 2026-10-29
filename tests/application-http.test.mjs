import {test} from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';
test('production auth requires Discord; application privacy, decisions and FiveM gate fail closed',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'omen-')),file=join(dir,'db.sqlite'),port=23000+Math.floor(Math.random()*1000),base=`http://127.0.0.1:${port}`,secret='e'.repeat(64);
 const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:String(port),PUBLIC_URL:base,FRONTEND_URL:base+'/',BRIDGE_SECRET:secret,DB_PATH:file,DISCORD_BOT_TOKEN:'',ALLOW_PASSWORD_LOGIN:'false',REQUIRE_APPLICATION:'true'},stdio:['ignore','pipe','pipe']});
 try{await new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error('startup')),5000);child.stdout.once('data',()=>{clearTimeout(timer);ok()})});
 const db=new DatabaseSync(file),owner='a'.repeat(64),player='b'.repeat(64),other='c'.repeat(64),hash=x=>createHash('sha256').update(x).digest('hex');
 for(const [name,id,license] of [['owner','1445069224899907709','license:abcd'],['player','111111111111111111','license:beef'],['other','222222222222222222',null]])db.prepare('INSERT INTO users(username,pass,discord_id,license) VALUES(?,?,?,?)').run(name,'unused',id,license);
 for(const [i,t] of [owner,player,other].entries())db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(t),i+1,Date.now()+60000);
 db.prepare("INSERT INTO applications(discord_id,answers,status,created_at) VALUES(?,?,'pending',?)").run('111111111111111111',JSON.stringify({story:'private answers'}),Date.now());
 const call=(path,t,data)=>fetch(base+path,{method:data?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:data?JSON.stringify(data):undefined});
 assert.equal((await call('/api/register','',{username:'player2',password:'password1234'})).status,403);
 assert.equal((await call('/api/applications','',{})).status,401);
 assert.equal((await (await call('/api/me',other)).json()).application,null);
 assert.equal((await call('/api/admin/applications',other)).status,403);
 assert.equal((await call('/api/admin/decision',other,{id:1,status:'accepted'})).status,403);
 assert.equal((await call('/api/admin/decision',owner,{id:1,status:'rejected',reason:''})).status,400);
 assert.equal((await call('/api/admin/decision',owner,{id:1,status:'accepted'})).status,200);
 assert.equal((await call('/api/admin/decision',owner,{id:1,status:'rejected',reason:'changed mind'})).status,409);
 assert.equal((await (await call('/api/me',player)).json()).application.status,'accepted');
 const bridge=async license=>(await fetch(base+'/bridge/identity',{method:'POST',headers:{Authorization:'Bearer '+secret},body:JSON.stringify({license})})).json();
 assert.equal((await bridge('license:beef')).approved,false,'missing Discord integration cannot bypass live membership');assert.equal((await bridge('license:abcd')).approved,true,'owner retains access');
 const config=await (await call('/api/config')).json();assert.equal(config.oauthReady,false);assert.equal(config.applicationsReady,false);assert.equal(config.DISCORD_BOT_TOKEN,undefined);
 assert.equal((await fetch(base+'/assets/omen-teaser.mp4',{headers:{Range:'bytes=0-99'}})).status,206);
 db.close();
 }finally{child.kill();await new Promise(r=>child.once('exit',r));rmSync(dir,{recursive:true,force:true})}
});

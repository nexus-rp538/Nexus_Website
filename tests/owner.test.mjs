import {test} from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';
test('owner identity, priority grants, CORS and branding authorization',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'owner-')),file=join(dir,'db.sqlite'),port=21000+Math.floor(Math.random()*1000),base=`http://127.0.0.1:${port}`,secret='b'.repeat(64),front='https://nexus-rp538.github.io';
 const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:String(port),PUBLIC_URL:base,FRONTEND_URL:front+'/Nexus_Website/',BRIDGE_SECRET:secret,DB_PATH:file},stdio:['ignore','pipe','pipe']});
 try{await new Promise((ok,no)=>{const t=setTimeout(()=>no(Error('startup')),5000);child.stdout.once('data',()=>{clearTimeout(t);ok()})});
 const db=new DatabaseSync(file);const owner='c'.repeat(64),ordinary='d'.repeat(64),sha=t=>createHash('sha256').update(t).digest('hex');
 db.prepare('INSERT INTO users(username,pass,discord_id) VALUES(?,?,?)').run('owner','unused','1445069224899907709');db.prepare('INSERT INTO users(username,pass,discord_id) VALUES(?,?,?)').run('guest','unused','111111111111111111');
 db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(owner),1,Date.now()+60000);db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(ordinary),2,Date.now()+60000);db.close();
 const call=(path,token,data)=>fetch(base+path,{method:data?'POST':'GET',headers:{Origin:front,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
 let r=await call('/api/me',owner);assert.equal(r.headers.get('access-control-allow-origin'),front);assert.equal((await r.json()).user.owner,true);
 assert.equal((await call('/api/admin/settings',ordinary,{name:'Not authorized'})).status,403);
 assert.equal((await call('/api/admin/settings',owner,{name:'My City',image:'https://example.com/logo.png',connect:'fivem://connect/127.0.0.1:30120'})).status,200);
 assert.equal((await (await fetch(base+'/api/config')).json()).name,'My City');
 assert.equal((await call('/api/admin/priority',ordinary,{discord_id:'111111111111111111'})).status,403);
 assert.equal((await call('/api/admin/priority',owner,{discord_id:'111111111111111111',hours:1})).status,200);
 const bridge=async(id,discord)=>(await fetch(base+'/bridge/identity',{method:'POST',headers:{Authorization:'Bearer '+secret},body:JSON.stringify({license:id,discord})})).json();
 assert.equal((await bridge('license:abcd','discord:111111111111111111')).bypass,true);
 assert.equal((await bridge('license:beef','discord:1445069224899907709')).bypass,true);
 await call('/api/admin/priority',owner,{discord_id:'111111111111111111',remove:true});assert.equal((await bridge('license:abcd','discord:111111111111111111')).bypass,false);
 assert.equal((await fetch(base+'/auth/discord/callback?state=fake&code=fake')).status,400);
 }finally{child.kill();await new Promise(r=>child.once('exit',r));rmSync(dir,{recursive:true,force:true})}
});

import {test} from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('register, authenticate, prove game identity, protect bridge and user data',async()=>{
 const temp=mkdtempSync(join(tmpdir(),'nq-'));const port=19000+Math.floor(Math.random()*1000),base=`http://127.0.0.1:${port}`,secret='a'.repeat(64);
 const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,ALLOW_PASSWORD_LOGIN:'true',REQUIRE_APPLICATION:'false',PORT:String(port),PUBLIC_URL:base,BRIDGE_SECRET:secret,COOKIE_SECURE:'false',DB_PATH:join(temp,'test.sqlite')},stdio:['ignore','pipe','pipe']});
 try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve()});child.once('exit',()=>reject(Error('server exited'))) });
 const post=(path,data,cookie='',bridge=false,origin=base)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie,...(bridge?{Authorization:`Bearer ${secret}`}:{})},body:JSON.stringify(data)});
 assert.equal((await post('/bridge/identity',{license:'license:abcd'})).status,401);
 assert.equal((await post('/api/register',{username:'player',password:'longpassword123'},'',false,'https://evil.test')).status,403);
 const reg=await post('/api/register',{username:'player',password:'longpassword123'});assert.equal(reg.status,200);const cookie=reg.headers.get('set-cookie').split(';')[0];
 assert.equal((await post('/api/login',{username:'player',password:'wrongpassword'})).status,401);
 const challenge=await (await post('/bridge/identity',{license:'license:abcd'},'',true)).json();assert.equal(challenge.registered,false);
 assert.equal((await post('/api/link',{code:challenge.code},cookie)).status,200);
 const identity=await (await post('/bridge/identity',{license:'license:abcd'},'',true)).json();assert.equal(identity.registered,true);
 await post('/bridge/status',{license:'license:abcd',position:10,total:30,status:'grace',graceUntil:Date.now()+20000},'',true);
 const me=await (await fetch(base+'/api/me',{headers:{Cookie:cookie}})).json();assert.equal(me.queue.position,10);assert.equal(me.queue.total,30);assert.equal(me.user.pass,undefined);
 const anon=await (await fetch(base+'/api/me')).json();assert.equal(anon.user,null);assert.equal(anon.queue,null);
 await post('/api/logout',{},cookie);assert.equal((await (await fetch(base+'/api/me',{headers:{Cookie:cookie}})).json()).user,null);
 }finally{child.kill();await new Promise(r=>child.once('exit',r));rmSync(temp,{recursive:true,force:true})}
});
